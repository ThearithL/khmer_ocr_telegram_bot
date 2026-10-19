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

let selectedFile = null;

function setStatus(text) { status.textContent = text; }
function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch (_) {} }

input.addEventListener('change', () => {
  selectedFile = input.files?.[0] || null;
  scanBtn.disabled = !selectedFile;
  if (selectedFile) {
    preview.src = URL.createObjectURL(selectedFile);
    preview.classList.remove('hidden');
    setStatus('Image selected');
    haptic();
  }
});

scanBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  scanBtn.disabled = true;
  scanBtn.textContent = '⏳ Scanning...';
  setStatus('Reading Khmer text...');

  const form = new FormData();
  form.append('image', selectedFile);

  try {
    const response = await fetch('/api/ocr', {
      method: 'POST',
      body: form,
      headers: {
        'X-Telegram-Init-Data': tg?.initData || '',
        'X-OCR-Language': language.value,
      }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'OCR failed');
    result.value = data.text || '';
    setStatus(data.text ? 'Done ✅' : 'No text found');
    haptic('medium');
  } catch (err) {
    setStatus('Error');
    result.value = `❌ ${err.message}`;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = '✨ Scan Text';
  }
});

copyBtn.addEventListener('click', async () => {
  if (!result.value.trim()) return;
  await navigator.clipboard.writeText(result.value);
  setStatus('Copied ✅');
  haptic();
});

sendBtn.addEventListener('click', () => {
  const text = result.value.trim();
  if (!text || !tg?.sendData) return;
  tg.sendData(JSON.stringify({ text: text.slice(0, 3800) }));
  setStatus('Sent to bot ✅');
  haptic('medium');
});

clearBtn.addEventListener('click', () => {
  selectedFile = null;
  input.value = '';
  preview.removeAttribute('src');
  preview.classList.add('hidden');
  result.value = '';
  scanBtn.disabled = true;
  setStatus('Ready');
  haptic();
});
