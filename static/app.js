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

scanBtn.addEventListener('click', async () => {
  if (!selectedBlob || !window.Tesseract) return;
  scanBtn.disabled = true;
  scanBtn.textContent = '⏳ Scanning…';
  progressWrap.classList.remove('hidden');
  updateProgress(0, 'Loading OCR engine…');
  setStatus('Reading text…');
  result.value = '';

  let worker;
  try {
    worker = await Tesseract.createWorker(language.value, 1, {
      logger: m => {
        if (m.status === 'recognizing text') updateProgress(m.progress, `Recognizing text ${Math.round((m.progress || 0) * 100)}%`);
        else progressText.textContent = m.status || 'Working…';
      }
    });
    await worker.setParameters({
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    });
    const { data } = await worker.recognize(selectedBlob);
    result.value = (data.text || '').trim();
    setStatus(result.value ? 'Done ✅' : 'No text found');
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
