// 연주 위치 따라가기: 인식한 악보의 사건(음 묶음) 순서와 들어온 소리의 12음 분포(크로마)를 온라인 DTW로 맞춘다.
// 소리 쪽 입력은 "새로 친 음들이 생긴 순간"마다의 크로마 벡터 (마이크 처리는 따로).

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
 * 쪽 인식 결과들 → 따라가기용 악보 사건 목록 [{page, sys, chroma, x}]
 *  - 단이 3개 이상인 줄(노래 + 피아노)은 아래 두 단(피아노)만 쓴다
 *  - 이웃 사건의 음을 조금 섞는다(spread): 화음이 여러 사건으로 쪼개지거나 두 손이 어긋나 인식된 경우에 덜 민감하게
 */
export function scoreEvents(pages, { spread = 0.35 } = {}) {
  const raw = [];
  pages.forEach((pg, pi) => pg.systems.forEach((sys, si) => {
    const nst = sys.staves ? sys.staves.length : 2;
    const minStaff = Math.max(0, nst - 2);
    sys.events.forEach((e) => {
      const ms = e.notes.filter((n) => n.staff >= minStaff).map((n) => n.midi);
      if (ms.length) raw.push({ page: pi, sys: si, x: e.x, c: chromaOf(ms) });
    });
  }));
  return raw.map((e, i) => {
    const c = Float32Array.from(e.c);
    for (const k of [i - 1, i + 1]) {
      const o = raw[k];
      if (o) for (let q = 0; q < 12; q++) c[q] += o.c[q] * spread;
    }
    return { page: e.page, sys: e.sys, x: e.x, chroma: normalize(c) };
  });
}

/**
 * 온라인 DTW 따라가기.
 *  - push(chroma): 연주 사건 하나를 넣고 지금 위치(악보 사건 번호)를 돌려줌
 *  - 악보 사건을 건너뛰는 비용(skip)은 인식 오류(가짜 음), 같은 자리에 머무는 비용(stay)은 연주 쪽 덧음·놓친 음을 흡수
 */
export class Follower {
  constructor(events, { skip = 0.15, stay = 0.5, window = 80, back = 12 } = {}) {
    this.back = back;
    this.ev = events;
    this.skip = skip; this.stay = stay; this.window = window;
    this.D = null;
    this.pos = 0;
  }
  push(chroma) {
    const N = this.ev.length, INF = 1e9;
    const prev = this.D;
    const D = new Float64Array(N).fill(INF);
    // 계산 범위: 지금 위치 근처만 (앞으로 window 개)
    const lo = prev ? Math.max(0, this.pos - this.back) : 0;
    const hi = prev ? Math.min(N - 1, this.pos + this.window) : Math.min(N - 1, this.window);
    for (let j = lo; j <= hi; j++) {
      const c = 1 - cos(chroma, this.ev[j].chroma);
      let best = INF;
      if (!prev) best = j * this.skip;             // 처음: 앞부분을 건너뛰고 시작할 수 있음
      else {
        if (j > 0 && prev[j - 1] < best) best = prev[j - 1];          // 다음 사건으로
        if (prev[j] + this.stay < best) best = prev[j] + this.stay;    // 같은 사건에 머묾
      }
      if (j > lo && D[j - 1] + this.skip < best) best = D[j - 1] + this.skip; // 악보 사건 건너뜀
      D[j] = best + c;
    }
    // 지금 위치 = 누적 비용이 가장 작은 곳 (뒤로 많이 가지 않게)
    let bj = lo, bv = INF;
    for (let j = lo; j <= hi; j++) if (D[j] < bv) { bv = D[j]; bj = j; }
    this.D = D;
    this.pos = bj;
    return bj;
  }
}
