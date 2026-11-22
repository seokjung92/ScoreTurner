// 악보 메모 (애플 펜슬): 쪽마다 획을 쪽 크기에 대한 비율 좌표로 저장해서 화면 크기·회전이 바뀌어도 같은 자리에 그린다.
// 저장 위치: 서재 cache "악보id:ink" (악보를 지우면 같이 지워짐). 기기 밖으로 나가지 않음.
import * as lib from './library.js';

export const TOOLS = {
  black: { color: '#111111', width: 0.0026, alpha: 1, label: '검정 펜' },
  red: { color: '#d3302a', width: 0.0026, alpha: 1, label: '빨강 펜' },
  blue: { color: '#1d5fd6', width: 0.0026, alpha: 1, label: '파랑 펜' },
  hi: { color: '#ffd400', width: 0.016, alpha: 0.38, label: '형광펜' },
};

export class InkStore {
  constructor(scoreId) {
    this.id = scoreId;
    this.data = {};
    this.undo = [];
    this.timer = 0;
  }
  async load() {
    try { this.data = (await lib.getCache(this.id + ':ink')) || {}; } catch (e) { this.data = {}; }
    return this;
  }
  strokes(page) { return this.data[page] || (this.data[page] = []); }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { lib.putCache(this.id + ':ink', this.data).catch(() => {}); }, 300);
  }
  flush() { clearTimeout(this.timer); return lib.putCache(this.id + ':ink', this.data).catch(() => {}); }
  add(page, s) { this.strokes(page).push(s); this.undo.push({ t: 'add', page, s }); this.save(); }
  /** (x, y) 반경 r(쪽 폭 비율) 안을 지나는 획을 지움 */
  eraseAt(page, x, y, r, aspect) {
    const arr = this.strokes(page);
    const hit = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i].pts;
      for (let k = 0; k < p.length; k += 3) {
        const dx = p[k] - x, dy = (p[k + 1] - y) * aspect;
        if (dx * dx + dy * dy <= r * r) { hit.push({ i, s: arr.splice(i, 1)[0] }); break; }
      }
    }
    if (hit.length) { this.undo.push({ t: 'erase', page, hit }); this.save(); }
    return hit.length > 0;
  }
  clear(page) {
    const arr = this.strokes(page);
    if (!arr.length) return false;
    this.undo.push({ t: 'clear', page, arr: arr.slice() });
    this.data[page] = [];
    this.save();
    return true;
  }
  /** 되돌리기. 바뀐 쪽 번호를 돌려줌 */
  undoLast() {
    const u = this.undo.pop();
    if (!u) return null;
    if (u.t === 'add') {
      const arr = this.strokes(u.page);
      const i = arr.lastIndexOf(u.s);
      if (i >= 0) arr.splice(i, 1);
    } else if (u.t === 'erase') {
      const arr = this.strokes(u.page);
      for (const h of u.hit.slice().reverse()) arr.splice(h.i, 0, h.s);
    } else if (u.t === 'clear') {
      this.data[u.page] = u.arr;
    }
    this.save();
    return u.page;
  }
}

function drawStroke(ctx, s, W, H) {
  const t = TOOLS[s.tool] || TOOLS.black;
  const p = s.pts;
  ctx.save();
  ctx.globalAlpha = t.alpha;
  ctx.strokeStyle = t.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'hi' || p.length <= 6) {
    ctx.lineWidth = t.width * W * (s.tool === 'hi' ? 1 : 0.5 + (p[2] || 0.5));
    ctx.beginPath();
    ctx.moveTo(p[0] * W, p[1] * H);
    for (let k = 3; k < p.length; k += 3) ctx.lineTo(p[k] * W, p[k + 1] * H);
    if (p.length <= 3) ctx.lineTo(p[0] * W + 0.1, p[1] * H);
    ctx.stroke();
  } else {
    // 필압에 따라 굵기가 바뀌는 펜: 짧은 선분을 이어 그림
    for (let k = 3; k < p.length; k += 3) {
      ctx.lineWidth = t.width * W * (0.5 + (p[k + 2] || 0.5));
      ctx.beginPath();
      ctx.moveTo(p[k - 3] * W, p[k - 2] * H);
      ctx.lineTo(p[k] * W, p[k + 1] * H);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * 쪽 그림 위에 메모 층을 붙인다.
 *  opts.isActive(): 메모 모드인지, opts.tool(): 지금 도구 이름('black'|'red'|'blue'|'hi'|'eraser')
 *  손가락(touch)으로는 그리지 않는다 (손바닥 오작동 방지). 펜슬·마우스만 그림
 */
export function attachInk(wrap, pageCanvas, page, store, opts) {
  const cv = document.createElement('canvas');
  cv.className = 'ink';
  const cssW = parseFloat(pageCanvas.style.width), cssH = parseFloat(pageCanvas.style.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  wrap.appendChild(cv);
  const ctx = cv.getContext('2d');

  const redraw = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const s of store.strokes(page)) drawStroke(ctx, s, cv.width, cv.height);
  };
  redraw();

  let cur = null;
  const norm = (e) => {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.pointerType === 'mouse' ? 0.5 : (e.pressure || 0.5)];
  };
  const erase = (e) => {
    const [x, y] = norm(e);
    if (store.eraseAt(page, x, y, 0.018, cssH / cssW)) redraw();
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!opts.isActive() || e.pointerType === 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    try { cv.setPointerCapture(e.pointerId); } catch (er) { /* 무시 */ }
    if (opts.tool() === 'eraser') { cur = { erase: true }; erase(e); return; }
    cur = { tool: opts.tool(), pts: norm(e) };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    e.preventDefault();
    e.stopPropagation();
    if (cur.erase) { erase(e); return; }
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const n = norm(ev);
      const k = cur.pts.length - 3;
      ctx.save();
      const t = TOOLS[cur.tool];
      ctx.globalAlpha = cur.tool === 'hi' ? 1 : t.alpha;
      ctx.strokeStyle = t.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = t.width * cv.width * (cur.tool === 'hi' ? 1 : 0.5 + n[2]);
      if (cur.tool === 'hi') { ctx.globalAlpha = t.alpha; }
      ctx.beginPath();
      ctx.moveTo(cur.pts[k] * cv.width, cur.pts[k + 1] * cv.height);
      ctx.lineTo(n[0] * cv.width, n[1] * cv.height);
      ctx.stroke();
      ctx.restore();
      cur.pts.push(...n);
    }
  });
  const end = (e) => {
    if (!cur) return;
    e.stopPropagation();
    if (!cur.erase) {
      cur.pts = cur.pts.map((v) => Math.round(v * 10000) / 10000);
      store.add(page, { tool: cur.tool, pts: cur.pts });
      redraw(); // 형광펜 겹침 등을 깔끔하게 다시 그림
    }
    cur = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  return { canvas: cv, redraw, page };
}
