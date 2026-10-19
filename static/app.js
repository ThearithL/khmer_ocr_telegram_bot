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

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error('Could not prepare image')),
      type,
      quality
    );
  });
}

function findBrightSpan(values, minRatio, fallbackStart, fallbackEnd) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= minRatio) {
      if (start < 0) start = i;
      end = i;
    }
  }
  if (start < 0 || end <= start) return [fallbackStart, fallbackEnd];
  return [start, end];
}

function detectDocumentCrop(ctx, width, height) {
  const sampleW = Math.min(420, width);
  const sampleH = Math.max(1, Math.round(height * sampleW / width));
  const c = document.createElement('canvas');
  c.width = sampleW;
  c.height = sampleH;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(ctx.canvas, 0, 0, sampleW, sampleH);
  const data = x.getImageData(0, 0, sampleW, sampleH).data;

  const rowScores = new Array(sampleH).fill(0);
  const colScores = new Array(sampleW).fill(0);
  for (let yy = 0; yy < sampleH; yy++) {
    for (let xx = 0; xx < sampleW; xx++) {
      const i = (yy * sampleW + xx) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum > 145) {
        rowScores[yy]++;
        colScores[xx]++;
      }
    }
  }

  for (let i = 0; i < rowScores.length; i++) rowScores[i] /= sampleW;
  for (let i = 0; i < colScores.length; i++) colScores[i] /= sampleH;

  let [top, bottom] = findBrightSpan(rowScores, 0.52, 0, sampleH - 1);
  let [left, right] = findBrightSpan(colScores, 0.52, 0, sampleW - 1);

  const marginX = Math.round(sampleW * 0.015);
  const marginY = Math.round(sampleH * 0.015);
  left = Math.max(0, left - marginX);
  right = Math.min(sampleW - 1, right + marginX);
  top = Math.max(0, top - marginY);
  bottom = Math.min(sampleH - 1, bottom + marginY);

  const sx = Math.round(left / sampleW * width);
  const sy = Math.round(top / sampleH * height);
  const sw = Math.max(1, Math.round((right - left + 1) / sampleW * width));
  const sh = Math.max(1, Math.round((bottom - top + 1) / sampleH * height));

  // Reject over-aggressive crops; keep most of the image for safety.
  if (sw < width * 0.55 || sh < height * 0.55) {
    return { sx: 0, sy: 0, sw: width, sh: height };
  }
  return { sx, sy, sw, sh };
}

async function buildOcrVariants(blob) {
  updateProgress(0.03, 'Detecting document…');
  const bitmap = await createImageBitmap(blob);

  const src = document.createElement('canvas');
  src.width = bitmap.width;
  src.height = bitmap.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, src.width, src.height);
  sctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const crop = detectDocumentCrop(sctx, src.width, src.height);
  const targetLong = 2800;
  const cropLong = Math.max(crop.sw, crop.sh);
  let scale = targetLong / cropLong;
  scale = Math.max(1, Math.min(scale, 2.2));

  const width = Math.max(1, Math.round(crop.sw * scale));
  const height = Math.max(1, Math.round(crop.sh * scale));
  const base = document.createElement('canvas');
  base.width = width;
  base.height = height;
  const bctx = base.getContext('2d', { willReadFrequently: true });
  bctx.fillStyle = '#fff';
  bctx.fillRect(0, 0, width, height);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(src, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

  updateProgress(0.07, 'Improving Khmer text…');
  const raw = bctx.getImageData(0, 0, width, height);

  // Variant 1: grayscale + local-friendly contrast boost.
  const grayCanvas = document.createElement('canvas');
  grayCanvas.width = width;
  grayCanvas.height = height;
  const gctx = grayCanvas.getContext('2d', { willReadFrequently: true });
  const grayImg = gctx.createImageData(width, height);
  const grayValues = new Uint8ClampedArray(width * height);

  for (let i = 0, p = 0; i < raw.data.length; i += 4, p++) {
    let g = Math.round(0.299 * raw.data[i] + 0.587 * raw.data[i + 1] + 0.114 * raw.data[i + 2]);
    g = Math.round((g - 132) * 1.38 + 132);
    g = Math.max(0, Math.min(255, g));
    if (g > 238) g = 255;
    grayValues[p] = g;
    grayImg.data[i] = grayImg.data[i + 1] = grayImg.data[i + 2] = g;
    grayImg.data[i + 3] = 255;
  }
  gctx.putImageData(grayImg, 0, 0);

  // Variant 2: adaptive threshold. This helps uneven lighting/shadows on phone photos.
  const binCanvas = document.createElement('canvas');
  binCanvas.width = width;
  binCanvas.height = height;
  const binCtx = binCanvas.getContext('2d', { willReadFrequently: true });
  const binImg = binCtx.createImageData(width, height);

  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += grayValues[(y - 1) * width + (x - 1)];
      integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + rowSum;
    }
  }

  const radius = Math.max(12, Math.round(Math.min(width, height) / 90));
  const offset = 16;
  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);
      const A = integral[y1 * (width + 1) + x1];
      const B = integral[y1 * (width + 1) + (x2 + 1)];
      const C = integral[(y2 + 1) * (width + 1) + x1];
      const D = integral[(y2 + 1) * (width + 1) + (x2 + 1)];
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const mean = (D - B - C + A) / count;
      const g = grayValues[y * width + x];
      const v = g < mean - offset ? 0 : 255;
      const i = (y * width + x) * 4;
      binImg.data[i] = binImg.data[i + 1] = binImg.data[i + 2] = v;
      binImg.data[i + 3] = 255;
    }
  }
  binCtx.putImageData(binImg, 0, 0);

  return {
    original: await canvasToBlob(base, 'image/jpeg', 0.94),
    grayscale: await canvasToBlob(grayCanvas, 'image/png'),
    adaptive: await canvasToBlob(binCanvas, 'image/png')
  };
}

function khmerScore(text) {
  const t = text || '';
  const khmer = (t.match(/[\u1780-\u17FF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const odd = (t.match(/[|+_~`]/g) || []).length;
  const lines = t.split('\n').filter(x => x.trim()).length;
  return khmer * 4 - latin * 1.5 - odd * 2 + Math.min(lines, 40) * 3 + Math.min(t.length, 2500) * 0.01;
}

function cleanupOcrText(text, lang) {
  let cleaned = (text || '')
    .replace(/\r/g, '')
    .replace(/[\t\u00A0]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  const lines = cleaned.split('\n');
  const out = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }

    if (lang === 'khm') {
      const khmerCount = (line.match(/[\u1780-\u17FF]/g) || []).length;
      const latinCount = (line.match(/[A-Za-z]/g) || []).length;

      if (khmerCount > 0 && latinCount > 0) {
        line = line.replace(/\b[A-Za-z]{1,15}\b/g, '').replace(/ {2,}/g, ' ').trim();
      }

      line = line
        .replace(/\s*[|+]+\s*$/g, '')
        .replace(/^[|+]+\s*/g, '')
        .replace(/\s+[._~`]+\s*$/g, '')
        .trim();

      const remainingKhmer = (line.match(/[\u1780-\u17FF]/g) || []).length;
      const meaningful = line.replace(/[\s|+._'"`~\-–—,:;!?()\[\]{}\/\\0-9]/g, '');
      if (remainingKhmer === 0 && meaningful.length <= 4) continue;

      // Remove tiny isolated edge-noise tokens after a very large whitespace gap.
      line = line.replace(/\s{3,}[\u1780-\u17FF]{1,2}\s*$/g, '').trim();
    }

    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function recognizePass(worker, blob, psm, label, start, span) {
  await worker.setParameters({
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    tessedit_pageseg_mode: String(psm)
  });
  const { data } = await worker.recognize(blob);
  updateProgress(start + span, label);
  return (data?.text || '').trim();
}

scanBtn.addEventListener('click', async () => {
  if (!selectedBlob || !window.Tesseract) return;
  scanBtn.disabled = true;
  scanBtn.textContent = '⏳ Scanning…';
  progressWrap.classList.remove('hidden');
  updateProgress(0, 'Preparing free OCR…');
  setStatus('Improving document…');
  result.value = '';

  let worker;
  try {
    const variants = await buildOcrVariants(selectedBlob);

    worker = await Tesseract.createWorker(language.value, 1, {
      logger: m => {
        if (m.status && m.status !== 'recognizing text') progressText.textContent = m.status;
      }
    });

    const candidates = [];

    setStatus('OCR pass 1/3…');
    updateProgress(0.12, 'Reading cleaned document…');
    candidates.push(await recognizePass(worker, variants.grayscale, 3, 'Pass 1 complete', 0.12, 0.25));

    setStatus('OCR pass 2/3…');
    updateProgress(0.40, 'Reading high-contrast document…');
    candidates.push(await recognizePass(worker, variants.adaptive, 6, 'Pass 2 complete', 0.40, 0.25));

    setStatus('OCR pass 3/3…');
    updateProgress(0.68, 'Checking original detail…');
    candidates.push(await recognizePass(worker, variants.original, 3, 'Pass 3 complete', 0.68, 0.22));

    let best = '';
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const cleaned = cleanupOcrText(candidate, language.value);
      const score = khmerScore(cleaned);
      if (score > bestScore) {
        best = cleaned;
        bestScore = score;
      }
    }

    result.value = best;
    setStatus(best ? 'Done ✅ • Free OCR' : 'No text found');
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
