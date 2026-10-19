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
const aiFixBtn = document.getElementById('aiFixBtn');
const copyBtn = document.getElementById('copyBtn');
const saveBtn = document.getElementById('saveBtn');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const sourceHint = document.getElementById('sourceHint');
const storageHint = document.getElementById('storageHint');

const HISTORY_KEY = 'khmer_ocr_history_v1';
const HISTORY_LIMIT = 20;
let selectedBlob = null;
let previewUrl = null;
let lastPreparedBlob = null;

function setStatus(text) { status.textContent = text; }
function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch (_) {} }
function updateProgress(value, text) {
  const pct = Math.max(0, Math.min(100, Math.round((value || 0) * 100)));
  progressBar.style.width = `${pct}%`;
  progressText.textContent = text || `OCR ${pct}%`;
}
function saveHistory(text, type = 'ocr') {
  const clean = (text || '').trim();
  if (!clean) return;
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    history.unshift({ id: Date.now(), type, language: language.value, text: clean, createdAt: new Date().toISOString() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
    storageHint.textContent = `Saved locally • ${Math.min(history.length, HISTORY_LIMIT)}/${HISTORY_LIMIT} recent results`;
  } catch (_) {}
}
function showBlob(blob, fromTelegram = false) {
  selectedBlob = blob;
  lastPreparedBlob = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  preview.src = previewUrl;
  preview.classList.remove('hidden');
  sourceHint.classList.toggle('hidden', !fromTelegram);
  scanBtn.disabled = false;
  setStatus(fromTelegram ? 'Telegram image loaded' : 'Image selected');
}
input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (!file) return;
  showBlob(file, false);
  haptic();
});

async function loadTelegramImage() {
  const fileId = new URLSearchParams(location.search).get('file_id');
  if (!fileId) return;
  setStatus('Loading Telegram image…');
  try {
    const response = await fetch(`/api/telegram-image?file_id=${encodeURIComponent(fileId)}`, {
      headers: { 'X-Telegram-Init-Data': tg?.initData || '' }
    });
    const data = response.ok ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.detail || `Image load failed (${response.status})`);
    showBlob(await response.blob(), true);
  } catch (err) {
    setStatus('Load failed');
    result.value = `❌ ${err.message}`;
  }
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Could not prepare image')),
    type,
    quality
  ));
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      if (comma < 0) return reject(new Error('Could not encode image'));
      resolve(value.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.readAsDataURL(blob);
  });
}

async function prepareOcrImages(blob) {
  updateProgress(.04, 'Preparing document…');
  const bitmap = await createImageBitmap(blob);
  const longSide = Math.max(bitmap.width, bitmap.height);
  const target = 2600;
  const scale = Math.min(2.2, Math.max(1, target / longSide));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const base = document.createElement('canvas');
  base.width = width;
  base.height = height;
  const bctx = base.getContext('2d', { willReadFrequently: true });
  bctx.fillStyle = '#fff';
  bctx.fillRect(0, 0, width, height);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const enhanced = document.createElement('canvas');
  enhanced.width = width;
  enhanced.height = height;
  const ectx = enhanced.getContext('2d', { willReadFrequently: true });
  const src = bctx.getImageData(0, 0, width, height);
  const out = ectx.createImageData(width, height);
  for (let i = 0; i < src.data.length; i += 4) {
    let g = Math.round(.299 * src.data[i] + .587 * src.data[i + 1] + .114 * src.data[i + 2]);
    g = Math.max(0, Math.min(255, Math.round((g - 128) * 1.45 + 128)));
    if (g > 238) g = 255;
    if (g < 45) g = 0;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = g;
    out.data[i + 3] = 255;
  }
  ectx.putImageData(out, 0, 0);

  return {
    original: await canvasToBlob(base, 'image/jpeg', .94),
    enhanced: await canvasToBlob(enhanced, 'image/png')
  };
}

function cleanupOcrText(text, lang) {
  let cleaned = (text || '')
    .replace(/\r/g, '')
    .replace(/[\t\u00A0]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  const output = [];
  for (let line of cleaned.split('\n')) {
    line = line.trim();
    if (!line) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      continue;
    }
    if (lang === 'khm') {
      const khmer = (line.match(/[\u1780-\u17FF]/g) || []).length;
      const latin = (line.match(/[A-Za-z]/g) || []).length;
      if (khmer && latin) line = line.replace(/\b[A-Za-z]{1,15}\b/g, '').replace(/ {2,}/g, ' ').trim();
      line = line.replace(/^[|+_.~`]+\s*/g, '').replace(/\s*[|+_.~`]+$/g, '').trim();
      const remainingKhmer = (line.match(/[\u1780-\u17FF]/g) || []).length;
      if (!remainingKhmer && line.replace(/[\s\d.,:;!?()\-–—/\\]/g, '').length <= 4) continue;
    }
    output.push(line);
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function scoreText(text) {
  const khmer = (text.match(/[\u1780-\u17FF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const garbage = (text.match(/[|+_~`]/g) || []).length;
  return khmer * 4 + Math.min(text.length, 3000) * .01 - latin - garbage * 2;
}

async function recognize(worker, blob, psm) {
  await worker.setParameters({
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    tessedit_pageseg_mode: String(psm)
  });
  const { data } = await worker.recognize(blob);
  return (data?.text || '').trim();
}

scanBtn.addEventListener('click', async () => {
  if (!selectedBlob) return;
  if (!window.Tesseract) {
    alert('OCR library did not load. Please refresh the page.');
    return;
  }
  scanBtn.disabled = true;
  aiFixBtn.disabled = true;
  scanBtn.textContent = '⏳ Scanning…';
  progressWrap.classList.remove('hidden');
  updateProgress(0, 'Preparing OCR…');
  setStatus('Preparing document…');
  result.value = '';

  let worker;
  try {
    const imgs = await prepareOcrImages(selectedBlob);
    lastPreparedBlob = imgs.original;
    updateProgress(.15, 'Loading Khmer OCR…');
    worker = await Tesseract.createWorker(language.value, 1, {
      logger: m => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          updateProgress(.15 + m.progress * .65, `Recognizing ${Math.round(m.progress * 100)}%…`);
        }
      }
    });

    setStatus('OCR pass 1/2…');
    const a = cleanupOcrText(await recognize(worker, imgs.enhanced, 6), language.value);
    updateProgress(.82, 'Checking full page…');
    setStatus('OCR pass 2/2…');
    const b = cleanupOcrText(await recognize(worker, imgs.original, 3), language.value);
    const best = scoreText(a) >= scoreText(b) ? a : b;

    result.value = best;
    saveHistory(best, 'ocr');
    setStatus(best ? 'Done ✅ • Use AI Check for original-image verification' : 'No text found');
    updateProgress(1, 'Done ✅');
    haptic('medium');
  } catch (err) {
    setStatus('OCR error');
    result.value = `❌ OCR failed: ${err.message}`;
  } finally {
    try { await worker?.terminate(); } catch (_) {}
    scanBtn.disabled = false;
    aiFixBtn.disabled = false;
    scanBtn.textContent = '✨ Scan Text';
  }
});

async function prepareAiImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const longSide = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 1800 / longSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvasToBlob(canvas, 'image/jpeg', .9);
}

aiFixBtn.addEventListener('click', async () => {
  const text = result.value.trim();
  if (!text) return setStatus('Scan text first');
  if (!selectedBlob) {
    setStatus('Original image required');
    alert('AI Check needs the original image.');
    return;
  }

  aiFixBtn.disabled = true;
  aiFixBtn.textContent = '⏳ Checking image…';
  progressWrap.classList.remove('hidden');
  updateProgress(.12, 'Preparing original image…');
  setStatus('AI comparing OCR with original image…');

  try {
    const aiBlob = await prepareAiImage(lastPreparedBlob || selectedBlob);
    const image = await blobToBase64(aiBlob);
    updateProgress(.35, 'AI reading original image…');
    const response = await fetch('/api/ai-fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language: language.value, image, image_mime: 'image/jpeg' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `AI Fix failed (${response.status})`);
    const corrected = String(data.text || '').trim();
    if (!corrected) throw new Error('AI returned empty text');
    result.value = corrected;
    saveHistory(corrected, data.image_verified ? 'ai-image-verified' : 'ai-fix');
    updateProgress(1, data.image_verified ? 'Verified with original image ✅' : 'AI Fix complete ✅');
    setStatus(data.image_verified ? 'AI checked against original image ✅' : 'AI Fix done ✅');
    haptic('medium');
  } catch (err) {
    setStatus('AI Check failed');
    alert(`AI Check: ${err.message}`);
  } finally {
    aiFixBtn.disabled = false;
    aiFixBtn.textContent = '🖼 AI Check & Fix';
  }
});

copyBtn.addEventListener('click', async () => {
  const text = result.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    result.select();
    document.execCommand('copy');
  }
  setStatus('Copied ✅');
  haptic();
});

saveBtn.addEventListener('click', () => {
  const text = result.value.trim();
  if (!text) return setStatus('No text to save');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `khmer-ocr-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  saveHistory(text, 'saved');
  setStatus('TXT saved ✅');
});

sendBtn.addEventListener('click', async () => {
  const text = result.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  sendBtn.textContent = '⏳ Sending…';
  try {
    if (tg?.initData) {
      const response = await fetch('/api/send-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg.initData },
        body: JSON.stringify({ text })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || 'Could not send text');
      setStatus(`Sent to bot ✅ • ${data.characters || text.length} chars`);
      saveHistory(text, 'sent');
      return;
    }
    if (tg?.sendData && text.length <= 3500) {
      tg.sendData(JSON.stringify({ type: 'ocr_result', text }));
      setStatus('Sent to bot ✅');
      return;
    }
    throw new Error('Open this Mini App from Telegram to send text');
  } catch (err) {
    setStatus(err.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = '📤 Send to Bot';
  }
});

clearBtn.addEventListener('click', () => {
  selectedBlob = null;
  lastPreparedBlob = null;
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

try {
  const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  if (saved.length) storageHint.textContent = `Saved locally • ${saved.length}/${HISTORY_LIMIT} recent results`;
} catch (_) {}

loadTelegramImage();