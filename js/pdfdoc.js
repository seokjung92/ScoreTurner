// pdf.js 감싸기: 문서 열기, 화면 크기에 맞춰 쪽 그리기, 인식용 회색 그림 만들기
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';

export async function loadPdf(blobOrBuffer) {
  const buf = blobOrBuffer instanceof Blob ? await blobOrBuffer.arrayBuffer() : blobOrBuffer;
  return pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    isEvalSupported: false,
  }).promise;
}

/** n쪽(1부터)을 boxW×boxH(CSS 픽셀) 안에 맞춰 그린 canvas. 실제 픽셀은 dpr 배 */
export async function renderFit(doc, n, boxW, boxH, dpr) {
  const page = await doc.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(boxW / v1.width, boxH / v1.height);
  // iPad 사파리 캔버스 한도(약 1,600만 픽셀)를 넘지 않게
  let px = dpr;
  const area = v1.width * scale * px * v1.height * scale * px;
  if (area > 14e6) px *= Math.sqrt(14e6 / area);
  const vp = page.getViewport({ scale: scale * px });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = Math.floor(v1.width * scale) + 'px';
  canvas.style.height = Math.floor(v1.height * scale) + 'px';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return canvas;
}

/** 미리보기 그림 (JPEG Blob) */
export async function thumbnail(doc, width = 260) {
  const page = await doc.getPage(1);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / v1.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
}

/** 인식용: n쪽을 세로 height 픽셀로 그려 회색값(0=검정, 255=흰색) 배열로 */
export async function renderGray(doc, n, height = 2200) {
  const page = await doc.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: height / v1.height });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  canvas.width = canvas.height = 0;
  return { width: Math.floor(vp.width), height: Math.floor(vp.height), data: gray };
}
