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

async function preprocessForOcr(blob) {
  updateProgress(0.03, 'Preparing image…');

  const bitmap = await createImageBitmap(blob);
  const longSide = Math.max(bitmap.width, bitmap.height);

  // OCR works much better when small Khmer glyphs are enlarged.
  // Target about 2400 px on the longest edge, capped to avoid memory problems.
  let scale = 1;
  if (longSide < 2200) scale = 2200 / longSide;
  if (longSide * scale > 3000) scale = 3000 / longSide;

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  updateProgress(0.06, 'Improving document contrast…');

  const image = ctx.getImageData(0, 0, width, height);
  const p = image.data;

  // Grayscale + gentle contrast boost + near-white background cleanup.
  // This keeps thin Khmer vowels/diacritics better than hard thresholding.
  const contrast = 1.42;
  const midpoint = 128;
  for (let i = 0; i < p.length; i += 4) {
    let gray = Math.round(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]);
    gray = Math.round((gray - midpoint) * contrast + midpoint);
    gray = Math.max(0, Math.min(255, gray));

    if (gray > 225) gray = 255;
    else if (gray < 45) gray = 0;

    p[i] = p[i + 1] = p[i + 2] = gray;
    p[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error('Could not preprocess image')),
      'image/png'
    );
  });
}

scanBtn.addEventListener('click', async () => {
  if (!selectedBlob || !window.Tesseract) return;
  scanBtn.disabled = true;
  scanBtn.textContent = '⏳ Scanning…';
  progressWrap.classList.remove('hidden');
  updateProgress(0, 'Loading OCR engine…');
  setStatus('Reading full document…');
  result.value = '';

  let worker;
  try {
    const preparedBlob = await preprocessForOcr(selectedBlob);

    worker = await Tesseract.createWorker(language.value, 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          // Leave the first 10% of the bar for preprocessing/loading.
          const adjusted = 0.1 + (m.progress || 0) * 0.9;
          updateProgress(adjusted, `Recognizing full page ${Math.round((m.progress || 0) * 100)}%`);
        } else {
          progressText.textContent = m.status || 'Working…';
        }
      }
    });

    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
      // 6 = assume one uniform block of text; works well for full-page documents.
      tessedit_pageseg_mode: '6'
    });

    const { data } = await worker.recognize(preparedBlob);
    let text = (data.text || '').trim();

    // If preprocessing produced unexpectedly little text, retry the original image.
    if (text.length < 120) {
      setStatus('Retrying original image…');
      progressText.textContent = 'Retrying OCR on original image…';
      const retry = await worker.recognize(selectedBlob);
      const retryText = (retry.data?.text || '').trim();
      if (retryText.length > text.length) text = retryText;
    }

    result.value = text;
    setStatus(text ? 'Done ✅' : 'No text found');
    updateProgress(1, 'Done ✅');
    haptic('medium');
  } catch (err) {
    setStatus('OCR error');
    result.value = `❌ OCR failed: ${err.message}`;
  } finally {
    try { await worker?.terminate(); } catch (_) {}
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
