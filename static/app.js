const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.requestFullscreen?.(); } catch (_) {}
}

const input = document.getElementById('imageInput');
const preview = document.getElementById('preview');
const scanBtn = document.getElementById('scanBtn');
const result = document.getElementById('result');
const status = document.getElementById('status');
const language = document.getElementById('language');
const copyBtn = document.getElementById('copyBtn');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const sourceHint = document.getElementById('sourceHint');

let selectedBlob = null;
let previewUrl = null;

function setStatus(text) { status.textContent = text; }
function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch (_) {} }
function updateProgress(value, text) {
  const pct = Math.max(0, Math.min(100, Math.round((value || 0) * 100)));
  progressBar.style.width = `${pct}%`;
  progressText.textContent = text || `OCR ${pct}%`;
}
function showBlob(blob, fromTelegram = false) {
  selectedBlob = blob;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  preview.src = previewUrl;
  preview.classList.remove('hidden');
  sourceHint.classList.toggle('hidden', !fromTelegram);
  scanBtn.disabled = false;
  setStatus(fromTelegram ? 'Telegram image loaded' : 'Image selected');
}

input.addEventListener('change', () => {
  const file = input.files?.[0] || null;
  if (!file) return;
  showBlob(file, false);
  haptic();
});

async function loadTelegramImage() {
  const params = new URLSearchParams(location.search);
  const fileId = params.get('file_id');
  if (!fileId) return;
  setStatus('Loading Telegram image…');
  try {
    const response = await fetch(`/api/telegram-image?file_id=${encodeURIComponent(fileId)}`, {
      headers: { 'X-Telegram-Init-Data': tg?.initData || '' }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'Cannot load Telegram image');
    }
    const blob = await response.blob();
    showBlob(blob, true);
  } catch (err) {
    setStatus('Load failed');
    result.value = `❌ ${err.message}`;
  }
}

async function prepareForCloudOcr(blob) {
  updateProgress(0.08, 'Preparing image…');
  const bitmap = await createImageBitmap(blob);
  const maxSide = 2400;
  const longSide = Math.max(bitmap.width, bitmap.height);
  const scale = longSide > maxSide ? maxSide / longSide : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error('Could not prepare image')),
      'image/jpeg',
      0.9
    );
  });
}

function cleanupOcrText(text, lang) {
  let cleaned = (text || '')
    .replace(/\r/g, '')
    .replace(/[\t\u00A0]+/g, ' ')
    .replace(/ {3,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (lang !== 'khm') return cleaned;

  const lines = cleaned.split('\n');
  const out = [];
  for (let line of lines) {
    line = line.trimEnd();
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    const khmerCount = (line.match(/[\u1780-\u17FF]/g) || []).length;
    const latinCount = (line.match(/[A-Za-z]/g) || []).length;

    // Remove isolated Latin OCR garbage while keeping punctuation and Khmer text.
    if (khmerCount > 0 && latinCount > 0) {
      line = line.replace(/\b[A-Za-z]{1,12}\b/g, '').replace(/ {2,}/g, ' ');
    }

    // Drop tiny non-Khmer noise-only lines.
    const meaningful = line.replace(/[\s|+._'"`~\-–—,:;!?()\[\]{}\/\\]/g, '');
    if (khmerCount === 0 && meaningful.length <= 3) continue;

    out.push(line.trim());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function runGoogleVision(blob) {
  const cloudBlob = await prepareForCloudOcr(blob);
  updateProgress(0.25, 'Sending to Google Vision…');

  const response = await fetch(`/api/ocr?language=${encodeURIComponent(language.value)}`, {
    method: 'POST',
    headers: { 'Content-Type': cloudBlob.type || 'image/jpeg' },
    body: cloudBlob
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.detail || 'Google Vision OCR failed');
    err.status = response.status;
    throw err;
  }

  updateProgress(0.95, 'Formatting text…');
  return cleanupOcrText(data.text || '', language.value);
}

async function preprocessForTesseract(blob) {
  const bitmap = await createImageBitmap(blob);
  const longSide = Math.max(bitmap.width, bitmap.height);
  let scale = 1;
  if (longSide < 2200) scale = 2200 / longSide;
  if (longSide * scale > 3000) scale = 3000 / longSide;

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const image = ctx.getImageData(0, 0, width, height);
  const p = image.data;
  for (let i = 0; i < p.length; i += 4) {
    let gray = Math.round(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]);
    gray = Math.round((gray - 128) * 1.3 + 128);
    gray = Math.max(0, Math.min(255, gray));
    p[i] = p[i + 1] = p[i + 2] = gray;
    p[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not preprocess image')), 'image/png');
  });
}

async function runTesseractFallback(blob) {
  if (!window.Tesseract) throw new Error('Fallback OCR engine is unavailable');
  setStatus('Using fallback OCR…');
  updateProgress(0.1, 'Loading fallback OCR…');

  const prepared = await preprocessForTesseract(blob);
  let worker;
  try {
    worker = await Tesseract.createWorker(language.value, 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          updateProgress(0.15 + (m.progress || 0) * 0.8, `Fallback OCR ${Math.round((m.progress || 0) * 100)}%`);
        }
      }
    });
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      tessedit_pageseg_mode: '3'
    });
    const { data } = await worker.recognize(prepared);
    return cleanupOcrText(data.text || '', language.value);
  } finally {
    try { await worker?.terminate(); } catch (_) {}
  }
}

scanBtn.addEventListener('click', async () => {
  if (!selectedBlob) return;
  scanBtn.disabled = true;
  scanBtn.textContent = '⏳ Scanning…';
  progressWrap.classList.remove('hidden');
  updateProgress(0, 'Starting Google Vision OCR…');
  setStatus('Google Vision OCR…');
  result.value = '';

  try {
    let text = '';
    try {
      text = await runGoogleVision(selectedBlob);
      setStatus('Google Vision done ✅');
    } catch (cloudErr) {
      console.warn('Google Vision failed, using fallback:', cloudErr);
      text = await runTesseractFallback(selectedBlob);
      setStatus('Fallback OCR done ✅');
    }

    result.value = text;
    setStatus(text ? 'Done ✅' : 'No text found');
    updateProgress(1, 'Done ✅');
    haptic('medium');
  } catch (err) {
    setStatus('OCR error');
    result.value = `❌ OCR failed: ${err.message}`;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = '✨ Scan Text';
  }
});

copyBtn.addEventListener('click', async () => {
  const text = result.value.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('Copied ✅');
  haptic();
});

sendBtn.addEventListener('click', () => {
  const text = result.value.trim();
  if (!text) return;
  if (!tg?.sendData) {
    setStatus('Open from Telegram to send');
    return;
  }
  tg.sendData(JSON.stringify({ type: 'ocr_result', text: text.slice(0, 3900) }));
  setStatus('Sent to bot ✅');
  haptic('medium');
});

clearBtn.addEventListener('click', () => {
  selectedBlob = null;
  input.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.removeAttribute('src');
  preview.classList.add('hidden');
  sourceHint.classList.add('hidden');
  result.value = '';
  scanBtn.disabled = true;
  progressWrap.classList.add('hidden');
  updateProgress(0, 'Preparing OCR…');
  setStatus('Ready');
  haptic();
});

loadTelegramImage();
