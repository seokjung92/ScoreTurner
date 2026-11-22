// 연주 위치 따라가기: 인식한 악보의 사건(음 묶음) 순서와 들어온 소리의 12음 분포(크로마)를 맞춘다.
//  - Tracker: 확률 모형(앱에서 씀) / Follower: 온라인 DTW(예전 방식, 모의 시험 runFollow용)
//  - AutoTurner: 위치 → 넘길 쪽
// 소리 쪽 입력은 "새로 친 음들이 생긴 순간"마다의 크로마 벡터 (마이크 처리는 listen.js).

/** 음 높이 목록 → 12음 분포 (배음 반영: 5도 위 0.25, 장3도 위 0.1) */
export function chromaOf(midis, out = new Float32Array(12)) {
  for (const m of midis) {
    const pc = ((m % 12) + 12) % 12;
    out[pc] += 1;
    out[(pc + 7) % 12] += 0.25;
    out[(pc + 4) % 12] += 0.1;
  }
  return out;
}

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function cos(a, b) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += a[i] * b[i];
  return s;
}

/**
 * 쪽 인식 결과들 → 따라가기용 악보 사건 목록 [{page, sys, chroma, x, xf}]
 *  - 단이 3개 이상인 줄(노래 + 피아노)은 아래 두 단(피아노)만 쓴다
 *  - 이웃 사건의 음을 조금 섞는다(spread): 화음이 여러 사건으로 쪼개지거나 두 손이 어긋나 인식된 경우에 덜 민감하게
 *  - xf: 줄 안에서의 가로 위치 (0 = 줄 시작, 1 = 줄 끝)
 */
export function scoreEvents(pages, { spread = 0.35 } = {}) {
  const raw = [];
  pages.forEach((pg, pi) => pg.systems.forEach((sys, si) => {
    const nst = sys.nst ?? (sys.staves ? sys.staves.length : 2);
    const minStaff = Math.max(0, nst - 2);
    const w = Math.max(1, (sys.right ?? 1) - (sys.left ?? 0));
    sys.events.forEach((e) => {
      const ms = e.notes.filter((n) => n.staff >= minStaff).map((n) => n.midi);
      if (ms.length) raw.push({ page: pi, sys: si, x: e.x, xf: sys.right ? (e.x - sys.left) / w : 0.5, c: chromaOf(ms) });
    });
  }));
  return raw.map((e, i) => {
    const c = Float32Array.from(e.c);
    for (const k of [i - 1, i + 1]) {
      const o = raw[k];
      if (o) for (let q = 0; q < 12; q++) c[q] += o.c[q] * spread;
    }
    return { page: e.page, sys: e.sys, x: e.x, xf: e.xf, chroma: normalize(c) };
  });
}

/**
 * 온라인 DTW 따라가기.
 *  - push(chroma): 연주 사건 하나를 넣고 지금 위치(악보 사건 번호)를 돌려줌
 *  - 악보 사건을 건너뛰는 비용(skip)은 인식 오류(가짜 음), 같은 자리에 머무는 비용(stay)은 연주 쪽 덧음·놓친 음을 흡수
 *  - reset(j): j번 사건 근처에서 새로 시작 (손으로 넘겼을 때, 다시 찾기로 옮겨 갈 때)
 */
export class Follower {
  constructor(events, { skip = 0.03, stay = 0.6, window = 80, back = 12 } = {}) {
    this.back = back;
    this.ev = events;
    this.skip = skip; this.stay = stay; this.window = window;
    this.D = null;
    this.pos = 0;
    this.start = 0;
  }
  reset(j = 0) {
    this.D = null;
    this.start = Math.max(0, Math.min(this.ev.length - 1, j));
    this.pos = this.start;
  }
  push(chroma) {
    const N = this.ev.length, INF = 1e9;
    const prev = this.D;
    const D = new Float64Array(N).fill(INF);
    // 계산 범위: 지금 위치 근처만 (앞으로 window 개)
    const lo = prev ? Math.max(0, this.pos - this.back) : this.start;
    const hi = Math.min(N - 1, (prev ? this.pos : this.start) + this.window);
    for (let j = lo; j <= hi; j++) {
      const c = 1 - cos(chroma, this.ev[j].chroma);
      let best = INF;
      if (!prev) best = (j - this.start) * this.skip;   // 처음: 시작점부터 건너뛰고 시작할 수 있음
      else {
        if (j > 0 && prev[j - 1] < best) best = prev[j - 1];          // 다음 사건으로
        if (prev[j] + this.stay < best) best = prev[j] + this.stay;    // 같은 사건에 머묾
      }
      if (j > lo && D[j - 1] + this.skip < best) best = D[j - 1] + this.skip; // 악보 사건 건너뜀
      D[j] = best + c;
    }
    // 지금 위치 = 누적 비용이 가장 작은 곳
    let bj = lo, bv = INF;
    for (let j = lo; j <= hi; j++) if (D[j] < bv) { bv = D[j]; bj = j; }
    this.D = D;
    this.pos = bj;
    return bj;
  }
}

/**
 * 확률로 따라가기 (은닉 마르코프 모형). 악보 사건마다 "지금 여기를 치고 있을 확률"을 들고 있다가
 * 연주 사건이 들어올 때마다
 *  1) 옮겨 가기: 대부분 다음 몇 사건으로(소리 쪽이 음을 놓치거나 인식이 가짜 음을 넣으니 여러 칸도),
 *     조금은 같은 자리에(덧음), 조금은 몇 마디 앞으로(틀려서 다시 치기), 아주 조금은 곡 어디로든(도돌이표·아무 데서 시작)
 *  2) 맞춰 보기: 들은 12음 분포가 그 사건과 비슷할수록 확률을 키움
 * 가장 확률이 큰 사건이 지금 위치, 그 근처에 모인 확률이 확신(conf).
 * 같은 선율이 여러 번 나와도 "어디로든" 확률이 작아서 지금 근처를 유지한다.
 */
export class Tracker {
  constructor(events, opts = {}) {
    this.ev = events;
    const N = events.length;
    this.N = N;
    this.tau = opts.tau ?? 0.18;           // 맞춰 보기의 날카로움 (작을수록 소리를 더 믿음)
    this.pStay = opts.pStay ?? 0.2;
    this.pBack = opts.pBack ?? 0.03;       // 몇 마디 앞에서 다시 치기
    this.backN = opts.backN ?? 60;
    this.pJump = opts.pJump ?? 0.01;       // 곡 어디로든
    this.stable = opts.stable ?? 3;        // 근처(몇 마디 앞)로 옮기기 전에 연속으로 확인할 횟수
    this.stableFar = opts.stableFar ?? 6;  // 아주 먼 곳(처음부터 다시 등)으로 옮길 때
    const maxAdv = opts.maxAdv ?? 8, q = opts.advQ ?? 0.55;
    const pAdv = 1 - this.pStay - this.pBack - this.pJump;
    let z = 0; const adv = [];
    for (let d = 1; d <= maxAdv; d++) { adv.push(Math.pow(q, d - 1)); z += adv[d - 1]; }
    this.adv = adv.map((v) => (v / z) * pAdv);
    this.a = new Float64Array(N);
    this.b = new Float64Array(N);
    this.cum = new Float64Array(N + 1);
    this.pos = 0; this.conf = 0; this.jumped = false;
    this.reset(0);
  }
  reset(j = 0) {
    const N = this.N;
    j = Math.max(0, Math.min(N - 1, j));
    this.a.fill(0.02 / N);
    for (let d = 0; d < 4 && j + d < N; d++) this.a[j + d] += 0.98 / 4;
    this.norm(this.a);
    this.pos = j; this.conf = 0; this.jumped = false;
    this.cand = -1; this.candN = 0;
  }
  norm(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i]; if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s; }
  push(chroma) {
    const { N, a, b, cum, adv } = this;
    // 1) 옮겨 가기
    cum[0] = 0;
    for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + a[i];
    const jumpAll = this.pJump / N;
    for (let j = 0; j < N; j++) {
      let v = this.pStay * a[j] + jumpAll;
      for (let d = 1; d <= adv.length && j - d >= 0; d++) v += adv[d - 1] * a[j - d];
      // j+1 .. j+backN 에 있던 확률 중 일부가 j로 되돌아옴 (위치마다 되돌아갈 곳이 backN개라 나눔)
      const hi = Math.min(N, j + 1 + this.backN);
      v += (this.pBack / this.backN) * (cum[hi] - cum[j + 1]);
      b[j] = v;
    }
    // 2) 맞춰 보기
    let s = 0;
    for (let j = 0; j < N; j++) {
      const e = this.ev[j].chroma;
      let c = 0;
      for (let k = 0; k < 12; k++) c += chroma[k] * e[k];
      b[j] *= Math.exp(-(1 - c) / this.tau);
      s += b[j];
    }
    for (let j = 0; j < N; j++) a[j] = b[j] / s;
    let bj = 0;
    for (let j = 1; j < N; j++) if (a[j] > a[bj]) bj = j;
    let m = 0;
    for (let j = Math.max(0, bj - 4); j <= Math.min(N - 1, bj + 4); j++) m += a[j];
    // 가장 확률 큰 곳이 잠깐 튀는 것은 무시: 지금 위치에서 자연스럽게 갈 수 있는 곳이면 바로 받고,
    // 먼 곳은 stable번 연속 그쪽(조금씩 나아가며)을 가리킬 때만 옮긴다
    this.jumped = false;
    const near = (x, from) => x >= from - 3 && x <= from + adv.length + 6;
    if (near(bj, this.pos)) { this.pos = bj; this.cand = -1; this.candN = 0; }
    else {
      if (this.cand >= 0 && near(bj, this.cand)) this.candN++;
      else this.candN = 1;
      this.cand = bj;
      const need = bj < this.pos - this.backN || bj > this.pos + 40 ? this.stableFar : this.stable;
      if (this.candN >= need) { this.pos = bj; this.jumped = true; this.cand = -1; this.candN = 0; }
    }
    // 확신: 지금 위치 근처에 모인 확률
    m = 0;
    for (let j = Math.max(0, this.pos - 4); j <= Math.min(N - 1, this.pos + 4); j++) m += a[j];
    this.conf = m;
    return this.pos;
  }
}

/** 사건 목록에서 쪽마다 첫 사건 번호 (없으면 다음 쪽 것) */
export function pageStarts(events, numPages) {
  const st = new Array(numPages + 1).fill(events.length);
  for (let j = events.length - 1; j >= 0; j--) st[events[j].page] = j;
  for (let p = numPages - 1; p >= 0; p--) if (st[p] > st[p + 1]) st[p] = st[p + 1];
  return st;
}

/**
 * 자동 넘김 판단. 화면에 보이는 쪽(first ~ first+perView-1, 1부터)과 따라가기 결과로 넘길 쪽을 정한다.
 *  - 앞으로: 보이는 마지막 쪽의 마지막 줄을 turnAt(줄 가로 위치 비율) 넘게 쳤을 때 미리 넘김 (두 번 연속 확인)
 *  - 늦게 따라잡기: 위치가 이미 다음 쪽이면 넘김
 *  - 뒤로: 다시 찾기로 앞 쪽으로 옮겨 갔거나, 앞 쪽 위치가 여러 번 이어질 때만 (미리 넘긴 뒤 남은 마지막 줄을 치는 동안은 그대로)
 *  - 확신(conf)이 낮으면 넘기지 않음. 늦게 넘기는 편이 잘못 넘기는 것보다 덜 방해된다
 */
export class AutoTurner {
  constructor(events, numPages, opts = {}) {
    this.ev = events;
    this.numPages = numPages;
    this.turnAt = opts.turnAt ?? 0.5;
    this.minConf = opts.minConf ?? 0.25;
    this.cooldown = opts.cooldown ?? 1.2;
    this.lastSys = new Array(numPages).fill(-1);
    for (const e of events) this.lastSys[e.page] = Math.max(this.lastSys[e.page], e.sys);
    this.jumpConf = opts.jumpConf ?? 0.45;
    this.until = 0; this.fwd = 0; this.back = 0; this.far = 0;
  }
  /** 손으로 넘겼거나 자동으로 넘긴 직후 */
  turned(now) { this.until = now + this.cooldown; this.fwd = this.back = this.far = 0; }
  /** 넘길 쪽(첫 쪽 번호, 1부터) 또는 null */
  decide({ pos, conf, jumped }, first, perView, now) {
    const e = this.ev[pos];
    if (!e) return null;
    const P = e.page + 1;
    const last = Math.min(this.numPages, first + perView - 1);
    if (now < this.until) return null;
    if (conf < this.minConf) { this.fwd = this.back = this.far = 0; return null; }
    const strong = jumped && conf >= this.jumpConf;
    // 앞으로: 보이는 마지막 쪽의 마지막 줄 뒷부분
    if (P === last && last < this.numPages && e.sys === this.lastSys[e.page] && e.xf >= this.turnAt) {
      this.back = this.far = 0;
      return ++this.fwd >= 2 ? first + perView : null;
    }
    if (P > last) {
      this.back = 0;
      if (P === last + 1) return ++this.fwd >= 2 || strong ? P : null;
      return ++this.far >= 6 || strong ? P : null;
    }
    // 뒤로 (미리 넘긴 뒤 남은 마지막 줄을 치는 동안은 그대로)
    if (P < first) {
      this.fwd = this.far = 0;
      if (P === first - 1 && e.sys === this.lastSys[e.page]) return null;
      return ++this.back >= 4 || strong ? P : null;
    }
    this.fwd = this.back = this.far = 0;
    return null;
  }
}
