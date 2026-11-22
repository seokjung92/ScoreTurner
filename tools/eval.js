// 대략 인식 정확도 측정: 정답(손으로 고친 MusicXML에서 뽑은 음)과 줄·단별로 비교
import { loadPdf, renderGray } from '../js/pdfdoc.js';
import { recognize, smoothKeys } from '../js/omr.js';
import { chromaOf, normalize, scoreEvents, Follower, Tracker, AutoTurner, pageStarts } from '../js/follow.js';
import { OnsetChroma } from '../js/listen.js';

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

// ---------- 소리로 시험: 가상 녹음(make_perf.py + render_perf.swift) → 분석 → 따라가기 → 자동 넘김 ----------
async function omrOf(id, height = 3000) {
  window.OMR ||= {};
  const ck = id + '@' + height;
  return window.OMR[ck] || (window.OMR[ck] = await evalSong(id, { height }));
}

async function loadWav(url, sr = 48000) {
  const buf = await (await fetch(url, { cache: 'reload' })).arrayBuffer();
  const ac = new OfflineAudioContext(1, 1, sr);
  const ab = await ac.decodeAudioData(buf);
  const x = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / ab.numberOfChannels; }
  return { x, sr: ab.sampleRate };
}

/**
 * opts: { scenario:'clean'|'repeat'|'startmid', snr: 잡음(dB, 없으면 무잡음), perView, turnAt, tracker:{}, listen:{}, verbose }
 */
window.runAudio = async (opts = {}, ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) => {
  out.textContent = '';
  const sc = opts.scenario || 'clean';
  const lines = [];
  const T = { groups: 0, hidden: 0, turns: 0, wrong: 0, late: [], ev: 0, okPage: 0, okSys: 0 };
  for (const id of ids) {
    const r = await omrOf(id, opts.height || 3000);
    const ev = scoreEvents(r.results, opts.events);
    const numPages = r.results.length;
    const starts = pageStarts(ev, numPages);
    const perf = await (await fetch(`${SRC}audio/${id}-${sc}.json`, { cache: 'reload' })).json();
    const { x, sr } = await loadWav(`${SRC}audio/${id}-${sc}.wav`);
    // 잡음 (방 소리·마이크 잡음 흉내)
    if (opts.snr != null) {
      let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i];
      const rms = Math.sqrt(e / x.length), amp = rms * Math.pow(10, -opts.snr / 20);
      let seed = 7, hum = 0;
      for (let i = 0; i < x.length; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const u = seed / 2147483648 - 0.5;
        hum = hum * 0.98 + u * 0.2; // 낮은 소리 쪽이 큰 잡음
        x[i] += amp * (u * 1.2 + hum * 2);
      }
    }
    const an = new OnsetChroma(sr, opts.listen);
    const trk = new Tracker(ev, opts.tracker);
    const turner = new AutoTurner(ev, numPages, { turnAt: opts.turnAt, minConf: opts.minConf, jumpConf: opts.jumpConf });
    const perView = opts.perView || 1;
    const tl = perf.timeline;
    let first = sc === 'startmid' ? tl[0].page + 1 : 1;
    trk.reset(starts[first - 1]);
    const display = [{ t: 0, first }];
    const hop = Math.round(sr * 0.016);
    let ti = 0, nEv = 0, okP = 0, okS = 0;
    const turnsLog = [];
    for (let i = an.n; i <= x.length; i += hop) {
      const t = i / sr;
      const e = an.frame(x.subarray(i - an.n, i), t);
      if (!e) continue;
      const pos = trk.push(e.chroma);
      while (ti + 1 < tl.length && tl[ti + 1].t <= e.t + 0.03) ti++;
      const truth = tl[ti];
      nEv++;
      if (opts.trace) (window.TRACE ||= []).push(`${e.t.toFixed(1)} 실제 ${truth.page + 1}-${truth.sys + 1} 추정 ${ev[pos].page + 1}-${ev[pos].sys + 1} #${pos} 확신 ${trk.conf.toFixed(2)}${trk.jumped ? ' 옮김' : ''}`);
      if (ev[pos].page === truth.page) okP++;
      if (ev[pos].page === truth.page && ev[pos].sys === truth.sys) okS++;
      const want = turner.decide({ pos, conf: trk.conf, jumped: trk.jumped }, first, perView, t);
      if (want != null) {
        let n = Math.max(1, Math.min(numPages, want));
        if (perView === 2) n = n - ((n - 1) % 2);
        if (n !== first) {
          turnsLog.push({ t, from: first, to: n, truth: `${truth.page + 1}쪽 ${truth.sys + 1}줄`, conf: trk.conf.toFixed(2), jumped: trk.jumped });
          first = n; turner.turned(t); display.push({ t, first });
        }
      }
    }
    // 화면 평가: 연주 중인 음이 화면에 보였나 (미리 넘긴 마지막 줄은 괜찮음)
    const lastSys = turner.lastSys;
    const shownAt = (t) => { let f = display[0].first; for (const d of display) { if (d.t <= t) f = d.first; else break; } return f; };
    const okVisible = (g, f) => {
      const P = g.page + 1;
      if (P >= f && P <= f + perView - 1) return true;
      return P === f - 1 && g.sys === lastSys[g.page]; // 미리 넘긴 뒤 남은 마지막 줄
    };
    let hidden = 0;
    for (const g of tl) if (!okVisible(g, shownAt(g.t + 0.4))) hidden++;
    let wrong = 0;
    for (const tr of turnsLog) {
      const g = tl.filter((q) => q.t <= tr.t).pop() || tl[0];
      const nextG = tl.find((q) => q.t > tr.t + 0.5);
      if (!okVisible(g, tr.to) && !(nextG && okVisible(nextG, tr.to))) { wrong++; tr.wrong = true; }
    }
    // 쪽이 바뀐 순간부터 화면이 따라오기까지 (음수 = 미리 넘김)
    const late = [];
    for (let k = 1; k < tl.length; k++) {
      if (tl[k].page === tl[k - 1].page) continue;
      const P = tl[k].page + 1;
      let when = null;
      for (const d of display) if (P >= d.first && P <= d.first + perView - 1) { if (when == null || Math.abs(d.t - tl[k].t) < Math.abs(when - tl[k].t)) when = d.t; }
      if (shownAt(tl[k].t) <= P && P <= shownAt(tl[k].t) + perView - 1 && (when == null || when > tl[k].t)) {
        // 이미 보이는 중
        const lastSwitch = display.filter((d) => d.t <= tl[k].t).pop();
        when = lastSwitch.t;
      }
      late.push(when == null ? Infinity : when - tl[k].t);
    }
    T.groups += tl.length; T.hidden += hidden; T.turns += turnsLog.length; T.wrong += wrong; T.late.push(...late);
    T.ev += nEv; T.okPage += okP; T.okSys += okS;
    const lateStr = late.map((v) => (v === Infinity ? '안넘김' : v.toFixed(1))).join(' ');
    const line = `${id}: 소리 사건 ${nEv}/${tl.length} · 위치(쪽) ${(okP / nEv * 100).toFixed(0)}% (줄) ${(okS / nEv * 100).toFixed(0)}% · 안 보인 음 ${(hidden / tl.length * 100).toFixed(1)}% · 넘김 ${turnsLog.length}번(잘못 ${wrong}) · 쪽 바뀜 대비 넘긴 시각(초) [${lateStr}]`;
    lines.push(line); log(line);
    if (opts.verbose) for (const tr of turnsLog) { const l = `   ${tr.t.toFixed(1)}초 ${tr.from}→${tr.to}쪽 (연주 ${tr.truth}, 확신 ${tr.conf}${tr.jumped ? ', 다시 찾음' : ''})${tr.wrong ? ' ✗' : ''}`; lines.push(l); log(l); }
  }
  const fin = T.late.filter((v) => v !== Infinity);
  const miss = T.late.length - fin.length;
  const tot = `전체(${sc}${opts.snr != null ? `, 잡음 ${opts.snr}dB` : ''}): 위치(쪽) ${(T.okPage / T.ev * 100).toFixed(1)}% (줄) ${(T.okSys / T.ev * 100).toFixed(1)}% · 안 보인 음 ${(T.hidden / T.groups * 100).toFixed(1)}% · 넘김 ${T.turns}번 중 잘못 ${T.wrong} · 쪽 바뀜 ${T.late.length}번 중 안 넘김 ${miss}, 넘긴 시각 가운데값 ${fin.sort((a, b) => a - b)[fin.length >> 1]?.toFixed(1)}초`;
  lines.push(tot); log(tot);
  return lines.join('\n');
};
/** 소리 분석만 따로 점검: 친 묶음을 사건으로 잡은 비율, 잡은 사건의 12음 분포가 실제 음과 얼마나 같은지 */
window.diagAudio = async (id, sc = 'clean', lopts = {}) => {
  const perf = await (await fetch(`${SRC}audio/${id}-${sc}.json`, { cache: 'reload' })).json();
  const { x, sr } = await loadWav(`${SRC}audio/${id}-${sc}.wav`);
  const an = new OnsetChroma(sr, lopts);
  const hop = Math.round(sr * 0.016), evs = [];
  for (let i = an.n; i <= x.length; i += hop) { const e = an.frame(x.subarray(i - an.n, i), i / sr); if (e) evs.push(e); }
  const groups = [];
  for (const n of perf.notes) { const g = groups[groups.length - 1]; if (g && Math.abs(g.t - n.t) < 0.04) g.m.push(n.midi); else groups.push({ t: n.t, m: [n.midi] }); }
  let matched = 0; const cs = [], dt = [];
  const used = new Set();
  for (const g of groups) {
    let best = null;
    for (const e of evs) if (Math.abs(e.t - g.t) < 0.1 && (!best || Math.abs(e.t - g.t) < Math.abs(best.t - g.t))) best = e;
    if (best) { matched++; used.add(best); dt.push(best.t - g.t); const c = normalize(chromaOf(g.m)); let s = 0; for (let q = 0; q < 12; q++) s += c[q] * best.chroma[q]; cs.push(s); }
  }
  cs.sort((a, b) => a - b); dt.sort((a, b) => a - b);
  return `${id}: 사건 ${evs.length} (남는 사건 ${evs.length - used.size}), 묶음 ${groups.length} 중 잡음 ${matched} (${(matched / groups.length * 100).toFixed(0)}%), 분포 유사도 가운데 ${cs[cs.length >> 1]?.toFixed(2)} 하위25% ${cs[cs.length >> 2]?.toFixed(2)}, 시각차 가운데 ${(dt[dt.length >> 1] * 1000).toFixed(0)}ms`;
};
log('준비됨');
