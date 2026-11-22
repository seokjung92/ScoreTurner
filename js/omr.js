// 쪽 넘기기용 "대략" 악보 인식.
// 목표: 줄(큰보표)마다 어떤 음들이 어떤 순서로 나오는지 대충 아는 것. 리듬·꾸밈음·임시표는 보지 않는다.
// 입력: 회색 그림 {width, height, data: Uint8Array(0=검정)}
// 출력: { spacing, systems: [{ top, bottom, left, right, staves: [{ lines:[y×5], left, right, clef }],
//                              events: [{ x, notes: [{ staff, pos, d, midi, y }] }] }] }
//   staff: 줄 안의 단 번호(0부터), pos: 맨 아래 줄 = 0, 칸·줄마다 1씩 위로
//   d: 음 이름 + 옥타브 (옥타브×7 + C0D1E2F3G4A5B6), midi: 조표를 반영한 음 높이

const STEPS_SEMI = [0, 2, 4, 5, 7, 9, 11];
// 조표의 #·b 순서 (음 이름 번호)
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];  // B E A D G C F

export function recognize(img, opts = {}) {
  const { width: W, height: H, data } = img;
  const thr = opts.threshold ?? 180;
  const B = new Uint8Array(W * H);
  for (let i = 0; i < B.length; i++) B[i] = data[i] < thr ? 1 : 0;

  const staves = findStaves(B, W, H);
  if (!staves.length) return { spacing: 0, systems: [] };
  const s = median(staves.map((st) => st.spacing));

  // 오선을 지운 그림
  const C = B.slice();
  removeStaffLines(C, W, H, staves);
  const filled = opts.fillHoles !== false ? fillSmallHoles(C, W, H, s) : new Uint8Array(W * H);

  const systems = groupSystems(B, W, H, staves, s);
  for (const sys of systems) {
    for (const st of sys.staves) st.clef = detectClef(C, W, st, sys.staves.indexOf(st), sys.staves.length);
    // 조표 (줄 첫머리의 #·b 개수). 단마다 조표가 끝나는 x(headerEnd)도 기록
    sys.key = detectKey(C, W, sys, s);
    const he = Math.max(...sys.staves.map((t) => t.headerEnd ?? t.left + s * 3));
    sys.staves.forEach((t) => { t.headerEnd = he; });
    // 줄 중간에서 바뀌는 음자리표
    for (const st of sys.staves) st.clefChanges = !opts.clefChanges ? [] : findClefChanges(C, W, H, st, s);
  }
  const heads = findHeads(C, W, H, staves, s, opts);

  // 머리를 줄·단에 배정
  for (const sys of systems) sys.heads = [];
  for (const h of heads) {
    let best = null, bestDist = Infinity;
    for (const sys of systems) {
      for (const st of sys.staves) {
        const top = st.lines[0], bot = st.lines[4];
        const dist = h.y < top ? top - h.y : h.y > bot ? h.y - bot : 0;
        if (dist < bestDist) { bestDist = dist; best = { sys, st }; }
      }
    }
    if (!best || bestDist > s * 4.6) continue; // 덧줄 4개 정도까지
    const { sys, st } = best;
    if (h.x < (st.headerEnd ?? st.left + s * 3.0) || h.x > st.right + s * 0.5) continue; // 음자리표·조표 자리, 오선 밖
    const pos = staffPos(st, h.y);
    // 오선 밖 음은 덧줄이 있어야 함 (페달 기호·셈여림·템포 표시 걸러냄)
    if (opts.ledger !== false && (pos <= -2 || pos >= 10) && !hasLedger(B, W, st, h.x, pos <= -2 ? -2 : 10)) continue;
    // 빔: 머리 위·아래 줄이 모두 가로로 길게 이어지면 머리가 아님
    if (opts.beam !== false && isBeam(C, W, h, s)) continue;
    // 기둥(한쪽으로 길게 뻗은 세로줄)이 붙어 있어야 함 (#·b·제자리표·음자리표 고리 걸러냄). 온음표는 놓침
    // 단, 속이 빈 넓은 머리(온음표)는 기둥 없이도 받음
    if (opts.stem !== false && !hasStem(C, W, H, h, s) && !(isHollow(filled, W, h, s) && wholeNoteWidth(C, W, h, s))) {
      if (opts.debug) (sys.rejected ||= []).push({ x: h.x, y: h.y, why: 'stem', info: stemInfo(C, W, H, h, s) });
      continue;
    }
    sys.heads.push({ x: h.x, y: h.y, staff: sys.staves.indexOf(st), pos });
  }

  for (const sys of systems) {
    const bars = opts.accidentals === false ? [] : findBarlines(B, W, sys, s);
    sys.bars = bars;
    for (const hd of sys.heads) {
      const st = sys.staves[hd.staff];
      const clef = clefAt(st, hd.x);
      hd.d = (clef === 'F' ? 18 : 30) + hd.pos; // 낮은음자리표 맨 아래 줄 G2, 높은음자리표 E4
      hd.acc = opts.accidentals === false ? null : accidentalOf(C, W, H, hd, s, sys.heads);
    }
    computeMidi(sys, sys.heads);
    sys.events = groupEvents(sys.heads, s);
    delete sys.heads;
    if (!opts.debug) delete sys.rejected;
  }
  return { spacing: s, systems };
}

function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[b.length >> 1];
}

// ---------- 오선 ----------
function findStaves(B, W, H) {
  // 가운데 띠(쪽 폭 20~45%)의 가로 검정 비율로 오선 줄 후보를 찾는다 (들여쓰기·짧은 마지막 줄에도 걸리게)
  const x0 = Math.floor(W * 0.2), x1 = Math.floor(W * 0.45), span = x1 - x0;
  const rowOn = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    const o = y * W;
    for (let x = x0; x < x1; x++) c += B[o + x];
    rowOn[y] = c > span * 0.6 ? 1 : 0;
  }
  const lines = [];
  for (let y = 0; y < H; y++) {
    if (!rowOn[y]) continue;
    let e = y;
    while (e + 1 < H && rowOn[e + 1]) e++;
    if (e - y < 8) lines.push({ y: (y + e) / 2, a: y, b: e });
    y = e;
  }
  const staves = [];
  for (let i = 0; i + 4 < lines.length;) {
    const g = [1, 2, 3, 4].map((k) => lines[i + k].y - lines[i + k - 1].y);
    const m = (g[0] + g[1] + g[2] + g[3]) / 4;
    if (m >= 4 && m <= 60 && g.every((v) => Math.abs(v - m) < Math.max(1.5, m * 0.2))) {
      const ls = lines.slice(i, i + 5);
      const st = { lines: ls.map((l) => l.y), thick: Math.max(...ls.map((l) => l.b - l.a + 1)), spacing: m };
      const ext = staffExtent(B, W, st);
      st.left = ext[0]; st.right = ext[1];
      staves.push(st);
      i += 5;
    } else i++;
  }
  return staves;
}

/** 오선이 시작·끝나는 x: 5줄 중 3줄 이상이 검정인 열이 이어지는 구간 */
function staffExtent(B, W, st) {
  const on = (x) => {
    let c = 0;
    for (const ly of st.lines) {
      const y = Math.round(ly);
      if (B[y * W + x] || B[(y - 1) * W + x] || B[(y + 1) * W + x]) c++;
    }
    return c >= 4;
  };
  const mid = Math.floor(W * 0.3);
  let l = mid, gap = 0;
  for (let x = mid; x >= 0; x--) { if (on(x)) { l = x; gap = 0; } else if (++gap > 4) break; }
  let r = mid; gap = 0;
  for (let x = mid; x < W; x++) { if (on(x)) { r = x; gap = 0; } else if (++gap > 4) break; }
  return [l, r];
}

function removeStaffLines(C, W, H, staves) {
  for (const st of staves) {
    const maxRun = st.thick + 2;
    for (const ly of st.lines) {
      const yc = Math.round(ly);
      for (let x = Math.max(0, st.left - 3); x <= Math.min(W - 1, st.right + 3); x++) {
        let y0 = -1;
        for (const dy of [0, -1, 1, -2, 2]) { if (C[(yc + dy) * W + x]) { y0 = yc + dy; break; } }
        if (y0 < 0) continue;
        let a = y0, b = y0;
        while (a - 1 >= 0 && C[(a - 1) * W + x]) a--;
        while (b + 1 < H && C[(b + 1) * W + x]) b++;
        if (b - a + 1 <= maxRun) for (let y = a; y <= b; y++) C[y * W + x] = 0;
      }
    }
  }
}

/** 작은 흰 구멍 메우기: 2분·온음표 머리의 속을 채워 4분음표 머리처럼 찾히게 */
function fillSmallHoles(C, W, H, s) {
  const filled = new Uint8Array(W * H);
  const lab = new Int32Array(W * H);
  const q = new Int32Array(W * H);
  const maxArea = s * s * 0.7, maxW = s * 1.3, maxH = s * 1.0;
  let id = 0;
  for (let i = 0; i < W * H; i++) {
    if (C[i] || lab[i]) continue;
    id++;
    let qh = 0, qt = 0;
    q[qt++] = i; lab[i] = id;
    let area = 0, minx = W, maxx = 0, miny = H, maxy = 0, touches = false, big = false;
    const members = [];
    while (qh < qt) {
      const p = q[qh++];
      const x = p % W, y = (p / W) | 0;
      area++;
      if (!big) members.push(p);
      if (area > maxArea) big = true;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
      if (x > 0 && !C[p - 1] && !lab[p - 1]) { lab[p - 1] = id; q[qt++] = p - 1; }
      if (x < W - 1 && !C[p + 1] && !lab[p + 1]) { lab[p + 1] = id; q[qt++] = p + 1; }
      if (y > 0 && !C[p - W] && !lab[p - W]) { lab[p - W] = id; q[qt++] = p - W; }
      if (y < H - 1 && !C[p + W] && !lab[p + W]) { lab[p + W] = id; q[qt++] = p + W; }
    }
    if (!touches && !big && maxx - minx + 1 <= maxW && maxy - miny + 1 <= maxH && area >= s * s * 0.05) {
      for (const p of members) { C[p] = 1; filled[p] = 1; }
    }
  }
  return filled;
}

/** 머리 가운데가 메운 구멍이면 속이 빈 머리 */
function isHollow(filled, W, h, s) {
  const r = Math.max(1, Math.round(s * 0.15));
  let c = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { n++; c += filled[Math.round(h.y + dy) * W + Math.round(h.x + dx)]; }
  return c >= n * 0.3;
}

/** 온음표 머리 폭: 가운데 가로 검정 길이가 1.35~2.3칸 (#·b·제자리표는 1칸 안팎) */
function wholeNoteWidth(C, W, h, s) {
  let best = 0;
  for (let dy = -Math.round(s * 0.1); dy <= Math.round(s * 0.1); dy++) {
    const y = Math.round(h.y + dy), x0 = Math.round(h.x);
    if (!C[y * W + x0]) continue;
    let a = x0, b = x0;
    while (a > 0 && C[y * W + a - 1]) a--;
    while (b < W - 1 && C[y * W + b + 1]) b++;
    best = Math.max(best, b - a + 1);
  }
  return best >= s * 1.35 && best <= s * 2.3;
}

// ---------- 줄(큰보표) 묶기 ----------
function groupSystems(B, W, H, staves, s) {
  const connected = (a, b) => {
    const xs = Math.max(0, Math.min(a.left, b.left) - 4), xe = Math.min(W - 1, Math.max(a.left, b.left) + Math.round(s * 0.8));
    const y0 = Math.round(a.lines[0]), y1 = Math.round(b.lines[4]);
    for (let x = xs; x <= xe; x++) {
      let c = 0;
      for (let y = y0; y <= y1; y++) c += B[y * W + x];
      if (c >= (y1 - y0 + 1) * 0.92) return true;
    }
    return false;
  };
  const links = [];
  for (let i = 0; i + 1 < staves.length; i++) links.push(connected(staves[i], staves[i + 1]));
  const systems = [];
  if (links.some(Boolean)) {
    let cur = [staves[0]];
    for (let i = 1; i < staves.length; i++) {
      if (links[i - 1]) cur.push(staves[i]);
      else { systems.push(cur); cur = [staves[i]]; }
    }
    systems.push(cur);
  } else {
    // 세로줄이 없으면 2단씩 묶음 (피아노 악보)
    for (let i = 0; i < staves.length; i += 2) systems.push(staves.slice(i, i + 2));
  }
  return systems.map((sts) => ({
    staves: sts,
    top: sts[0].lines[0], bottom: sts[sts.length - 1].lines[4],
    left: Math.min(...sts.map((t) => t.left)), right: Math.max(...sts.map((t) => t.right)),
  }));
}

/** 음자리표: 높은음자리표는 오선 아래로 꼬리가 내려온다. 판단이 애매하면 위 단 G, 아래 단 F */
function detectClef(C, W, st, idx, n) {
  const s = st.spacing;
  const x0 = Math.round(st.left + s * 0.3), x1 = Math.round(st.left + s * 3.2);
  const below = (y0, y1) => {
    let c = 0;
    for (let y = Math.round(y0); y <= Math.round(y1); y++) for (let x = x0; x <= x1; x++) c += C[y * W + x];
    return c;
  };
  const tail = below(st.lines[4] + s * 0.4, st.lines[4] + s * 1.3);
  const top = below(st.lines[0] - s * 1.3, st.lines[0] - s * 0.4);
  if (tail > s * 0.8 && top > s * 0.8) return 'G';
  if (tail < s * 0.2 && top < s * 0.2) return 'F';
  return idx === n - 1 && n > 1 ? 'F' : 'G';
}

/** 조표: 단 첫머리에서 음자리표 다음 덩어리들을 왼쪽부터 보며 #·b 모양을 센다. 양수 = #, 음수 = b */
function detectKey(C, W, sys, s) {
  const counts = sys.staves.map((st) => keyOfStaff(C, W, st, s));
  // 단마다 결과가 다르면 개수가 많은 쪽 (음표 머리에 가려 하나를 놓치는 경우가 더 흔함)
  return counts.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
}

function keyOfStaff(C, W, st, s) {
  st.headerEnd = st.left + s * 3.0;
  const xa = Math.max(0, Math.round(st.left + s * 0.2)), xb = Math.min(W - 1, Math.round(st.left + s * 13));
  const ya = Math.max(0, Math.round(st.lines[0] - s * 2.5)), yb = Math.round(st.lines[4] + s * 2.5);
  const comps = componentsIn(C, W, xa, ya, xb, yb).filter((c) => c.n >= s * s * 0.12);
  comps.sort((p, q) => p.minx - q.minx);
  // 음자리표: 처음 나오는 높이 2.6칸 이상 덩어리
  const ci = comps.findIndex((c) => c.maxy - c.miny >= s * 2.6 && c.minx < st.left + s * 3);
  if (ci < 0) return 0;
  let x = comps[ci].maxx;
  st.headerEnd = Math.max(st.headerEnd, x + s * 0.3);
  let sharps = 0, flats = 0;
  st.keyTrace = comps.slice(ci, ci + 9).map((c) => `${((c.minx - st.left) / s).toFixed(1)}~${((c.maxx - st.left) / s).toFixed(1)} h${((c.maxy - c.miny + 1) / s).toFixed(1)} w${((c.maxx - c.minx + 1) / s).toFixed(1)} v${verticalStrokes(C, W, c, s)}`).join(' | ');
  for (let i = ci + 1; i < comps.length; i++) {
    let c = comps[i];
    if (c.maxx <= x) continue; // 음자리표에 딸린 점 등
    if (c.minx - x > s * 1.6) break; // 간격이 크면 조표 끝
    // b의 세로획과 둥근 부분이 오선 지우기로 갈라진 경우: 가는 세로획 바로 오른쪽의 획 없는 작은 덩어리를 합침
    const nx = comps[i + 1];
    if ((c.maxx - c.minx + 1) <= s * 0.4 && nx && nx.minx - c.maxx <= s * 0.35 && verticalStrokes(C, W, nx, s) === 0) {
      const nh = (nx.maxy - nx.miny + 1) / s;
      if (nh >= 0.6 && nh <= 1.6 && nx.maxy <= c.maxy + s * 0.3 && nx.miny >= c.miny) {
        c = { n: c.n + nx.n, minx: c.minx, maxx: nx.maxx, miny: c.miny, maxy: Math.max(c.maxy, nx.maxy) };
        i++;
      }
    }
    const h = (c.maxy - c.miny + 1) / s, w = (c.maxx - c.minx + 1) / s;
    if (h < 1.9 || h > 3.7 || w < 0.5 || w > 1.4) break; // 박자표·음표·세로줄 → 끝
    const strokes = verticalStrokes(C, W, c, s);
    if (strokes >= 2) sharps++;
    else if (strokes === 1) flats++;
    else break;
    x = c.maxx;
    st.headerEnd = x + s * 0.3;
  }
  if (sharps && !flats) return Math.min(7, sharps);
  if (flats && !sharps) return -Math.min(7, flats);
  return 0;
}

/** 덩어리 안에서 길이 1.6칸 이상 세로획의 개수 (#은 2, b은 1) */
function verticalStrokes(C, W, c, s) {
  let groups = 0, inGroup = false;
  for (let x = c.minx; x <= c.maxx; x++) {
    let best = 0, run = 0;
    for (let y = c.miny; y <= c.maxy; y++) {
      if (C[y * W + x]) { run++; if (run > best) best = run; } else run = 0;
    }
    const on = best >= s * 1.6;
    if (on && !inGroup) groups++;
    inGroup = on;
  }
  return groups;
}

/** 사각형 안의 검정 덩어리 (8방향) */
function componentsIn(C, W, xa, ya, xb, yb) {
  const w = xb - xa + 1, h = yb - ya + 1;
  const seen = new Uint8Array(w * h);
  const out = [];
  const q = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (seen[i] || !C[(y + ya) * W + x + xa]) continue;
    q.length = 0; q.push(i); seen[i] = 1;
    let n = 0, minx = w, maxx = 0, miny = h, maxy = 0;
    for (let k = 0; k < q.length; k++) {
      const p = q[k], px = p % w, py = (p / w) | 0;
      n++;
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && C[(ny + ya) * W + nx + xa]) { seen[j] = 1; q.push(j); }
      }
    }
    out.push({ n, minx: minx + xa, maxx: maxx + xa, miny: miny + ya, maxy: maxy + ya });
  }
  return out;
}

// ---------- 음표 머리 ----------
function findHeads(C, W, H, staves, s, opts) {
  // 오선 근처만 본다
  const band = new Uint8Array(H);
  for (const st of staves) {
    for (let y = Math.max(0, Math.floor(st.lines[0] - s * 5)); y <= Math.min(H - 1, Math.ceil(st.lines[4] + s * 5)); y++) band[y] = 1;
  }
  // 적분 그림
  const I = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += C[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const sum = (xa, ya, xb, yb) => I[(yb + 1) * (W + 1) + xb + 1] - I[ya * (W + 1) + xb + 1] - I[(yb + 1) * (W + 1) + xa] + I[ya * (W + 1) + xa];
  const rx = Math.max(1, Math.round(s * (opts.rx ?? 0.34))), ry = Math.max(1, Math.round(s * (opts.ry ?? 0.27)));
  const need = (2 * rx + 1) * (2 * ry + 1) * (opts.fill ?? 0.92);
  const core = new Uint8Array(W * H);
  for (let y = ry; y < H - ry; y++) {
    if (!band[y]) continue;
    for (let x = rx; x < W - rx; x++) {
      if (!C[y * W + x]) continue;
      if (sum(x - rx, y - ry, x + rx, y + ry) >= need) core[y * W + x] = 1;
    }
  }
  // 덩어리
  const heads = [];
  const seen = new Uint8Array(W * H);
  const q = [];
  for (let i = 0; i < W * H; i++) {
    if (!core[i] || seen[i]) continue;
    q.length = 0; q.push(i); seen[i] = 1;
    let n = 0, sx = 0, sy = 0, minx = W, maxx = 0, miny = H, maxy = 0;
    for (let k = 0; k < q.length; k++) {
      const p = q[k], x = p % W, y = (p / W) | 0;
      n++; sx += x; sy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const r = p + dy * W + dx;
        if (r >= 0 && r < W * H && core[r] && !seen[r]) { seen[r] = 1; q.push(r); }
      }
    }
    const w = maxx - minx + 1, h = maxy - miny + 1;
    if (w > s * 1.0) continue;             // 겹친 빔 등 긴 덩어리
    if (h > s * 0.85) {
      // 세로로 붙은 머리 여러 개 → 나눔
      const k = Math.round((h + s * 0.55) / s);
      if (k < 2 || k > 6) continue;
      for (let j = 0; j < k; j++) heads.push({ x: sx / n, y: miny + (h * (j + 0.5)) / k, k });
      continue;
    }
    heads.push({ x: sx / n, y: sy / n });
  }
  // 머리 모양 확인: 머리 크기 타원 안이 대부분 검정이고, 그보다 넓은 테두리는 덜 검정
  return heads.filter((hd) => {
    const a = s * 0.55, b = s * 0.42;
    let inC = 0, inN = 0;
    for (let y = Math.round(hd.y - b); y <= Math.round(hd.y + b); y++) {
      for (let x = Math.round(hd.x - a); x <= Math.round(hd.x + a); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const ex = (x - hd.x) / a, ey = (y - hd.y) / b;
        if (ex * ex + ey * ey > 1) continue;
        inN++; inC += C[y * W + x];
      }
    }
    return inN > 0 && inC / inN >= (opts.headFill ?? 0.72);
  });
}

/** 덧줄: pos 자리(맨 아래 줄 = 0, -2 = 아래 첫 덧줄, 10 = 위 첫 덧줄)에 머리 폭 정도의 가로줄이 있는지 */
function hasLedger(B, W, st, x, pos) {
  const L = st.lines, s = (L[4] - L[0]) / 4;
  const yc = Math.round(L[4] - (pos * s) / 2);
  const xa = Math.round(x - s * 0.7), xb = Math.round(x + s * 0.7);
  for (const dy of [0, -1, 1, -2, 2]) {
    let c = 0;
    for (let xx = xa; xx <= xb; xx++) c += B[(yc + dy) * W + xx];
    if (c >= (xb - xa + 1) * 0.85) return true;
  }
  return false;
}

/** 기둥: 머리 양옆(0.3~0.85칸)에서 머리 높이에서 시작해 위나 아래로 need칸 이상 이어지는 세로줄 (1픽셀 흔들림 허용) */
function hasStem(B, W, H, h, s, needS = 1.7) {
  const need = s * needS;
  const trace = (x, y, dir) => {
    // y 에서 dir(-1 위, +1 아래)로 따라간 마지막 y
    let cx = x, cy = y;
    for (;;) {
      const ny = cy + dir;
      if (ny < 0 || ny >= H) return cy;
      if (B[ny * W + cx]) { cy = ny; continue; }
      if (cx > 0 && B[ny * W + cx - 1]) { cy = ny; cx--; continue; }
      if (cx < W - 1 && B[ny * W + cx + 1]) { cy = ny; cx++; continue; }
      return cy;
    }
  };
  for (const side of [-1, 1]) {
    for (let dx = Math.round(s * 0.3); dx <= Math.round(s * 0.85); dx++) {
      const x = Math.round(h.x + side * dx);
      if (x < 1 || x >= W - 1) continue;
      for (let dy = -Math.round(s * 0.45); dy <= Math.round(s * 0.45); dy++) {
        const y = Math.round(h.y + dy);
        if (y < 0 || y >= H || !B[y * W + x]) continue;
        const top = trace(x, y, -1), bot = trace(x, y, 1);
        const up = h.y - top, down = bot - h.y;
        // 위 기둥은 머리 오른쪽, 아래 기둥은 머리 왼쪽 (b·제자리표는 왼쪽 획이 위로 뻗어서 걸러짐).
        // 2도 화음에서 반대쪽에 붙은 머리는 기둥이 머리 아래·위로도 이어짐
        if (side > 0 && (up >= need || (down >= need && up >= s * 0.8))) return true;
        if (side < 0 && (down >= need || (up >= need && down >= s * 0.8))) return true;
        dy = Math.max(dy, Math.round(bot - h.y)); // 이 검정 구간 다음부터 계속
      }
    }
  }
  return false;
}

/** 확인용: 양옆 기둥 후보의 위·아래 길이(칸) */
function stemInfo(B, W, H, h, s) {
  const out = [];
  for (const side of [-1, 1]) {
    for (let dx = Math.round(s * 0.3); dx <= Math.round(s * 0.85); dx++) {
      const x = Math.round(h.x + side * dx);
      let a = -1;
      for (let dy = -Math.round(s * 0.45); dy <= Math.round(s * 0.45); dy++) { const y = Math.round(h.y + dy); if (B[y * W + x]) { a = y; break; } }
      if (a < 0) continue;
      let t = a, b = a;
      while (t > 0 && B[(t - 1) * W + x]) t--;
      while (b < H - 1 && B[(b + 1) * W + x]) b++;
      out.push(`${side * dx}:${((h.y - t) / s).toFixed(1)}/${((b - h.y) / s).toFixed(1)}`);
    }
  }
  return out.join(' ');
}

/** 조표·임시표(그 마디 끝까지 같은 단·같은 자리)를 반영한 음 높이 */
function computeMidi(sys, notes) {
  const bars = sys.bars || [];
  const byStaff = new Map();
  for (const hd of [...notes].sort((a, b) => a.x - b.x)) {
    if (!byStaff.has(hd.staff)) byStaff.set(hd.staff, { bar: -1, alts: new Map() });
    const ctx = byStaff.get(hd.staff);
    let bi = 0;
    while (bi < bars.length && bars[bi] < hd.x) bi++;
    if (bi !== ctx.bar) { ctx.bar = bi; ctx.alts.clear(); }
    if (hd.acc != null) ctx.alts.set(hd.d, hd.acc);
    const step = ((hd.d % 7) + 7) % 7, oct = Math.floor(hd.d / 7);
    let alt = 0;
    if (sys.key > 0 && SHARP_ORDER.slice(0, sys.key).includes(step)) alt = 1;
    if (sys.key < 0 && FLAT_ORDER.slice(0, -sys.key).includes(step)) alt = -1;
    if (ctx.alts.has(hd.d)) alt = ctx.alts.get(hd.d);
    hd.midi = 12 * (oct + 1) + STEPS_SEMI[step] + alt;
  }
}

/** 곡 전체(쪽들의 인식 결과)에서 앞뒤 줄과 다르게 튀는 조표를 바로잡고 음 높이를 다시 계산 */
export function smoothKeys(pages) {
  const all = pages.flatMap((p) => p.systems);
  const keys = all.map((x) => x.key);
  for (let i = 0; i < all.length; i++) {
    const prev = keys[i - 1], next = keys[i + 1], next2 = keys[i + 2];
    let k = keys[i];
    if (prev !== undefined && next !== undefined && prev === next && k !== prev) k = prev;
    else if (prev === undefined && next !== undefined && next === next2 && k !== next) k = next;
    else if (next === undefined && prev !== undefined && prev === keys[i - 2] && k !== prev) k = prev;
    if (k !== all[i].key) {
      all[i].key = k;
      computeMidi(all[i], all[i].events.flatMap((e) => e.notes));
    }
  }
  return pages;
}

/** 마디 세로줄: 줄의 모든 단을 위아래로 꿰는 가는 세로줄의 x 목록 */
function findBarlines(B, W, sys, s) {
  const xs = [];
  const y0 = Math.round(sys.top), y1 = Math.round(sys.bottom);
  const stTop = sys.staves.map((t) => [Math.round(t.lines[0]), Math.round(t.lines[4])]);
  for (let x = Math.round(sys.left + s * 2); x <= Math.round(sys.right); x++) {
    // 각 단의 첫 줄~끝 줄이 다 검정
    let ok = true;
    for (const [a, b] of stTop) {
      let c = 0;
      for (let y = a; y <= b; y++) c += B[y * W + x];
      if (c < (b - a + 1) * 0.95) { ok = false; break; }
    }
    if (!ok) continue;
    // 단 사이도 대부분 검정이면 세로줄 (음표 기둥은 단 사이를 다 잇지 않음). 한 단짜리 줄은 그대로 인정
    if (stTop.length > 1) {
      let c = 0;
      for (let y = y0; y <= y1; y++) c += B[y * W + x];
      if (c < (y1 - y0 + 1) * 0.9) continue;
    }
    if (!xs.length || x - xs[xs.length - 1] > s * 0.6) xs.push(x);
  }
  return xs;
}

/** 머리 바로 왼쪽의 임시표: 1 = #, -1 = b, 0 = 제자리표, null = 없음 */
function accidentalOf(C, W, H, hd, s, heads) {
  const xa = Math.max(0, Math.round(hd.x - s * 2.6)), xb = Math.round(hd.x - s * 0.75);
  const ya = Math.max(0, Math.round(hd.y - s * 2.0)), yb = Math.min(H - 1, Math.round(hd.y + s * 1.8));
  if (xb <= xa) return null;
  let comps = componentsIn(C, W, xa, ya, xb, yb).filter((c) => c.n >= s * s * 0.1);
  // 다른 음표 머리를 품은 덩어리는 제외
  comps = comps.filter((c) => !heads.some((o) => o !== hd && o.x >= c.minx && o.x <= c.maxx && o.y >= c.miny && o.y <= c.maxy));
  comps.sort((a, b) => b.maxx - a.maxx);
  for (let i = 0; i < comps.length; i++) {
    let c = comps[i];
    if (c.minx <= xa || c.miny <= ya || c.maxy >= yb) continue; // 사각형에 걸쳐 잘린 덩어리 (빔·이음줄 등)
    // b이 세로획과 둥근 부분으로 갈라진 경우 합침
    const bowl = comps.find((o) => o !== c && o.minx > c.maxx && o.minx - c.maxx <= s * 0.35 && o.miny >= c.miny && o.maxy <= c.maxy + s * 0.3);
    if (bowl && c.maxx - c.minx + 1 <= s * 0.4) c = { ...c, maxx: bowl.maxx, maxy: Math.max(c.maxy, bowl.maxy) };
    const h = (c.maxy - c.miny + 1) / s, w = (c.maxx - c.minx + 1) / s;
    if (h < 1.7 || h > 3.6 || w < 0.4 || w > 1.4) continue;
    const st = strokeSpans(C, W, c, s);
    const cy = (c.miny + c.maxy) / 2;
    if (st.length >= 2) {
      const [l, r] = [st[0], st[st.length - 1]];
      if (Math.abs(cy - hd.y) > s * 0.9) continue;
      // 제자리표: 왼쪽 획이 위로, 오른쪽 획이 아래로 치우침
      if (l.top < r.top - s * 0.35 && r.bot > l.bot + s * 0.35) return 0;
      return 1;
    }
    if (st.length === 1) {
      // b: 둥근 부분의 아래 끝이 머리 높이 근처
      const below = (c.maxy - hd.y) / s;
      if (below >= -0.1 && below <= 1.0) return -1;
    }
  }
  return null;
}

/** 덩어리 안 세로획(1.4칸 이상)들의 위·아래 끝 */
function strokeSpans(C, W, c, s) {
  const out = [];
  let cur = null;
  for (let x = c.minx; x <= c.maxx; x++) {
    let best = 0, run = 0, bt = 0, bb = 0, start = 0;
    for (let y = c.miny; y <= c.maxy; y++) {
      if (C[y * W + x]) { if (!run) start = y; run++; if (run > best) { best = run; bt = start; bb = y; } } else run = 0;
    }
    if (best >= s * 1.4) {
      if (cur && x - cur.x1 <= 1) { cur.x1 = x; cur.top = Math.min(cur.top, bt); cur.bot = Math.max(cur.bot, bb); }
      else { cur = { x0: x, x1: x, top: bt, bot: bb }; out.push(cur); }
    }
  }
  return out;
}

function isBeam(C, W, h, s) {
  const runAt = (y) => {
    y = Math.round(y);
    const x0 = Math.round(h.x);
    if (!C[y * W + x0]) return 0;
    let a = x0, b = x0;
    while (a > 0 && C[y * W + a - 1] && x0 - a < s * 4) a--;
    while (b < W - 1 && C[y * W + b + 1] && b - x0 < s * 4) b++;
    return b - a + 1;
  };
  return runAt(h.y - s * 0.3) > s * 2.4 && runAt(h.y + s * 0.3) > s * 2.4;
}

/** 줄 중간 음자리표: 오선을 거의 다 덮는 높은음자리표(높이 5.5칸 이상), 또는 낮은음자리표(높이 2.5~3.6칸, 오른쪽에 점 두 개) */
function findClefChanges(C, W, H, st, s) {
  const xa = Math.round((st.headerEnd ?? st.left + s * 3) + s * 0.5), xb = Math.round(st.right - s * 0.5);
  const ya = Math.max(0, Math.round(st.lines[0] - s * 2.5)), yb = Math.min(H - 1, Math.round(st.lines[4] + s * 2.5));
  if (xb <= xa) return [];
  const comps = componentsIn(C, W, xa, ya, xb, yb);
  const out = [];
  for (const c of comps) {
    const h = (c.maxy - c.miny + 1) / s, w = (c.maxx - c.minx + 1) / s;
    const fill = c.n / ((c.maxx - c.minx + 1) * (c.maxy - c.miny + 1));
    if (h >= 5.5 && h <= 8.5 && w >= 1.2 && w <= 3.2 && fill < 0.45 && c.miny < st.lines[0] && c.maxy > st.lines[4]) {
      out.push({ x: c.minx, clef: 'G' });
    } else if (h >= 2.4 && h <= 3.8 && w >= 1.5 && w <= 3.0 && fill < 0.5 &&
               Math.abs(c.miny - st.lines[0]) < s * 0.8 && c.maxy < st.lines[4] + s * 0.5) {
      // 오른쪽에 작은 점 두 개 (넷째·셋째 칸)
      const dots = comps.filter((o) => o.minx > c.maxx && o.minx - c.maxx < s * 0.8 && o.n < s * s * 0.4 &&
        o.maxx - o.minx < s * 0.6 && o.miny > st.lines[0] && o.maxy < st.lines[2] + s * 0.3);
      if (dots.length >= 2) out.push({ x: c.minx, clef: 'F' });
    }
  }
  return out.sort((a, b) => a.x - b.x);
}

function clefAt(st, x) {
  let clef = st.clef;
  for (const ch of st.clefChanges || []) if (ch.x < x) clef = ch.clef;
  return clef;
}

function staffPos(st, y) {
  // 5줄 위치를 이용해 반 칸 단위로 (맨 아래 줄 = 0)
  const L = st.lines;
  const s = (L[4] - L[0]) / 4;
  return Math.round((2 * (L[4] - y)) / s);
}

function groupEvents(heads, s) {
  heads.sort((a, b) => a.x - b.x);
  const events = [];
  for (const h of heads) {
    const last = events[events.length - 1];
    if (last && h.x - last.x0 <= s * 0.9) {
      last.notes.push(h);
    } else {
      events.push({ x0: h.x, notes: [h] });
    }
  }
  return events.map((e) => ({
    x: e.notes.reduce((a, n) => a + n.x, 0) / e.notes.length,
    notes: e.notes.map((n) => ({ staff: n.staff, pos: n.pos, d: n.d, midi: n.midi, acc: n.acc, y: n.y, x: n.x })),
  }));
}
