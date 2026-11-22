// 대략 인식 정확도 측정: 정답(손으로 고친 MusicXML에서 뽑은 음)과 줄·단별로 비교
import { loadPdf, renderGray } from '../js/pdfdoc.js';
import { recognize, smoothKeys } from '../js/omr.js';
import { chromaOf, normalize, scoreEvents, Follower } from '../js/follow.js';

const SRC = 'http://127.0.0.1:8766/';
const out = document.getElementById('out');
const log = (s) => { out.textContent += s + '\n'; };

function multisetTP(a, b) {
  const m = new Map();
  for (const v of a) m.set(v, (m.get(v) || 0) + 1);
  let tp = 0;
  for (const v of b) { const c = m.get(v) || 0; if (c > 0) { tp++; m.set(v, c - 1); } }
  return tp;
}

/** 곡 하나 측정. key: 'd'(오선 위치) 또는 'midi'(조표 반영 음 높이) */
async function evalSong(id, opts) {
  const gt = await (await fetch(SRC + id + '.json')).json();
  const doc = await loadPdf(await (await fetch(SRC + id + '.pdf')).arrayBuffer());
  const r = { id, sysGT: 0, sysFound: 0, sysMatch: 0, gt: 0, found: 0, tp: 0, tpMidi: 0, pages: [] };
  const results = [], times = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const img = await renderGray(doc, p, opts.height || 2200);
    const t0 = performance.now();
    results.push(recognize(img, opts));
    times.push(performance.now() - t0);
  }
  if (opts.smooth !== false) smoothKeys(results);
  r.results = results;
  for (let p = 1; p <= doc.numPages; p++) {
    const res = results[p - 1], ms = times[p - 1];
    const gsys = gt.pages[p - 1].systems;
    r.sysGT += gsys.length;
    r.sysFound += res.systems.length;
    if (gsys.length === res.systems.length) r.sysMatch += gsys.length;
    const n = Math.min(gsys.length, res.systems.length);
    let pgGT = 0, pgFound = 0, pgTP = 0;
    for (let i = 0; i < n; i++) {
      const gs = gsys[i], rs = res.systems[i];
      const nst = rs.staves.length;
      for (const staff of [1, 2]) {
        const ridx = nst - 2 + (staff - 1); // 피아노 = 아래 두 단
        const g = gs.notes.filter((x) => x.staff === staff);
        const f = rs.events.flatMap((e) => e.notes).filter((x) => x.staff === ridx);
        const tp = multisetTP(g.map((x) => x.d), f.map((x) => x.d));
        const tpm = multisetTP(g.map((x) => x.midi), f.map((x) => x.midi));
        r.gt += g.length; r.found += f.length; r.tp += tp; r.tpMidi += tpm;
        pgGT += g.length; pgFound += f.length; pgTP += tp;
      }
    }
    for (let i = n; i < gsys.length; i++) { const c = gsys[i].notes.length; r.gt += c; pgGT += c; }
    r.pages.push(`${p}쪽 줄 ${res.systems.length}/${gsys.length} 재현 ${(pgTP / Math.max(1, pgGT) * 100).toFixed(0)}% 정밀 ${(pgTP / Math.max(1, pgFound) * 100).toFixed(0)}% 조표 ${res.systems.map((x) => x.key).join(',')} 음자리표 ${res.systems.map((x) => x.staves.map((t) => t.clef).join('')).join(' ')} ${ms.toFixed(0)}ms`);
  }
  await doc.destroy();
  return r;
}

// 모의 연주: 정답 음을 시각 순서대로 묶어 연주 사건으로. 놓친 음·틀린 음을 섞고, 앞 소리의 울림(페달)을 더함
function simulate(gt, { miss = 0.15, wrong = 0.08, sustain = 0.5, seed = 1 } = {}) {
  let r = seed;
  const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const notes = [];
  gt.pages.forEach((pg, pi) => pg.systems.forEach((sys, si) => sys.notes.forEach((n) => { if (!n.tied) notes.push({ ...n, page: pi, sys: si }); })));
  notes.sort((a, b) => a.t - b.t);
  const out = [];
  let prev = new Float32Array(12);
  for (let i = 0; i < notes.length;) {
    let j = i;
    while (j < notes.length && Math.abs(notes[j].t - notes[i].t) < 1e-6) j++;
    const group = notes.slice(i, j);
    const midis = [];
    for (const n of group) {
      if (rnd() < miss) continue;
      midis.push(rnd() < wrong ? n.midi + (rnd() < 0.5 ? 1 : -1) : n.midi);
    }
    if (midis.length) {
      const c = chromaOf(midis);
      for (let k = 0; k < 12; k++) c[k] += prev[k] * sustain;
      normalize(c);
      prev = c;
      out.push({ chroma: c, page: group[0].page, sys: group[0].sys });
    }
    i = j;
  }
  return out;
}

/** 따라가기 모의 시험: 매 연주 사건마다 추정 줄·쪽이 정답과 같은 비율 */
window.runFollow = async (opts = {}, ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) => {
  out.textContent = '';
  const lines = [];
  let T = { n: 0, sys: 0, page: 0, late: 0 };
  for (const id of ids) {
    const ck = id + '@' + (opts.height || 2200);
    window.OMR ||= {};
    const r = window.OMR[ck] || (window.OMR[ck] = await evalSong(id, opts));
    const gt = await (await fetch(SRC + id + '.json')).json();
    const ev = scoreEvents(r.results, opts.events);
    let n = 0, okSys = 0, okPage = 0, lateTurn = 0;
    for (const seed of [1, 2, 3]) {
      const perf = simulate(gt, { ...opts.sim, seed });
      const f = new Follower(ev, opts.follow);
      let lastPage = 0;
      perf.forEach((p, i) => {
        const j = f.push(p.chroma);
        const e = ev[j];
        n++;
        if (e.page === p.page && e.sys === p.sys) okSys++;
        if (e.page === p.page) okPage++;
        // 쪽이 바뀐 뒤 10개 사건 안에 따라왔는지
        if (p.page !== lastPage) { lastPage = p.page; if (!perf.slice(i, i + 10).some((q, k) => ev[f.pos].page === p.page)) lateTurn++; }
      });
    }
    T.n += n; T.sys += okSys; T.page += okPage;
    const line = `${id}: 줄 맞힘 ${(okSys / n * 100).toFixed(1)}% · 쪽 맞힘 ${(okPage / n * 100).toFixed(1)}% (연주 사건 ${n / 3}개 × 3회)`;
    lines.push(line); log(line);
  }
  const tot = `전체: 줄 맞힘 ${(T.sys / T.n * 100).toFixed(1)}% · 쪽 맞힘 ${(T.page / T.n * 100).toFixed(1)}%`;
  lines.push(tot); log(tot);
  return lines.join('\n');
};

window.runEval = async (opts = {}, ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) => {
  out.textContent = '';
  const lines = [];
  let T = { gt: 0, found: 0, tp: 0, tpMidi: 0, sysGT: 0, sysMatch: 0 };
  for (const id of ids) {
    const r = await evalSong(id, opts);
    for (const k of Object.keys(T)) T[k] += r[k];
    const line = `${id}: 줄 일치 ${r.sysMatch}/${r.sysGT} · 음 재현율 ${(r.tp / r.gt * 100).toFixed(1)}% · 정밀도 ${(r.tp / r.found * 100).toFixed(1)}% · 조표 반영 재현율 ${(r.tpMidi / r.gt * 100).toFixed(1)}%`;
    lines.push(line, ...(opts.verbose ? r.pages.map((x) => '   ' + x) : []));
    log(line);
  }
  const tot = `전체: 줄 일치 ${T.sysMatch}/${T.sysGT} · 음 재현율 ${(T.tp / T.gt * 100).toFixed(1)}% · 정밀도 ${(T.tp / T.found * 100).toFixed(1)}% · 조표 반영 재현율 ${(T.tpMidi / T.gt * 100).toFixed(1)}%`;
  lines.push(tot);
  log(tot);
  return lines.join('\n');
};

/** 한 쪽의 인식 결과를 그려 본다 (확인용) */
window.drawPage = async (id, p, opts = {}, crop = null) => {
  const doc = await loadPdf(await (await fetch(SRC + id + '.pdf')).arrayBuffer());
  const img = await renderGray(doc, p, opts.height || 2200);
  const res = recognize(img, { ...opts, debug: true });
  const cv = document.getElementById('dbg');
  const [cx, cy, cw, ch] = crop || [0, 0, img.width, img.height];
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const id2 = ctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = img.data[(y + cy) * img.width + x + cx], o = (y * cw + x) * 4;
    id2.data[o] = id2.data[o + 1] = id2.data[o + 2] = v; id2.data[o + 3] = 255;
  }
  ctx.putImageData(id2, 0, 0);
  ctx.translate(-cx, -cy);
  const names = 'CDEFGAB';
  res.systems.forEach((sys, si) => {
    ctx.strokeStyle = 'rgba(0,120,255,.8)'; ctx.lineWidth = 2;
    ctx.strokeRect(sys.left, sys.top, sys.right - sys.left, sys.bottom - sys.top);
    ctx.fillStyle = 'blue'; ctx.font = '20px sans-serif';
    ctx.fillText(`#${si + 1} key ${sys.key} ${sys.staves.map((t) => t.clef).join('')}`, sys.left, sys.top - 8);
    for (const r of sys.rejected || []) {
      ctx.strokeStyle = 'rgba(255,140,0,.95)'; ctx.lineWidth = 3;
      ctx.strokeRect(r.x - res.spacing * 0.6, r.y - res.spacing * 0.5, res.spacing * 1.2, res.spacing);
    }
    ctx.lineWidth = 2;
    for (const e of sys.events) for (const n of e.notes) {
      ctx.strokeStyle = n.staff === sys.staves.length - 1 ? 'rgba(0,160,0,.9)' : 'rgba(230,0,0,.9)';
      ctx.beginPath(); ctx.arc(n.x, n.y, res.spacing * 0.6, 0, 7); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.font = `${Math.round(res.spacing * 0.9)}px sans-serif`;
      ctx.fillText(names[((n.d % 7) + 7) % 7] + Math.floor(n.d / 7), n.x - res.spacing * 0.6, n.y - res.spacing * 0.8);
    }
  });
  await doc.destroy();
  return `spacing ${res.spacing}, systems ${res.systems.length}, events ${res.systems.map((s) => s.events.length).join(',')}`;
};
log('준비됨');
