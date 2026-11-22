// 마이크로 듣기: 소리에서 "새로 친 음들"이 생기는 순간마다 12음 분포(크로마)를 만든다.
//  - 짧은 구간마다 FFT → 스펙트럼 봉우리를 반음 칸(MIDI 번호)에 모음 → 칸별 세기
//  - 세기가 여러 칸에서 갑자기 커지면 "쳤다"(onset)고 보고, 커진 만큼만 모아 크로마로 만든다
//    (앞에서 울리던 음은 빠지고 새로 친 음만 남음. 배음은 같은 음 이름·5도·3도로 들어가며 악보 쪽 chromaOf가 이를 흉내 냄)
//  - 소리는 이 기기 안에서 숫자로만 바뀌고 저장·전송하지 않는다.
import { audioContext } from './audio.js';

const LO = 24, HI = 108; // C1 ~ C8 칸만 본다

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/**
 * 소리 → 연주 사건. 마이크 없이도 쓸 수 있게(시험용) 소리 조각을 직접 넣는 구조.
 *  frame(samples, t): 길이 n인 최근 소리 조각과 그 끝 시각(초). 사건이 완성되면 {t, chroma, strength} 를 돌려줌
 */
export class OnsetChroma {
  constructor(sampleRate, opts = {}) {
    this.sr = sampleRate;
    this.n = opts.n || (sampleRate > 50000 ? 8192 : 4096);
    this.win = new Float32Array(this.n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.n - 1)));
    this.re = new Float32Array(this.n);
    this.im = new Float32Array(this.n);
    this.e = new Float32Array(128);       // 지금 칸별 세기 (압축)
    this.hist = [];                        // 최근 프레임 [{t, e, total}]
    this.fluxHist = [];
    this.floor = 1e-4;                     // 배경 소리 크기 (천천히 따라감)
    this.peakLevel = 1e-3;                 // 최근 가장 큰 소리 (천천히 줄어듦)
    this.pending = null;                   // 친 뒤 모으는 중인 사건
    this.lastOnset = -1;
    this.lastFlux = 0;
    this.rising = false;
    this.minGap = opts.minGap ?? 0.08;     // 사건 사이 최소 간격(초)
    this.collect = opts.collect ?? 0.03;   // 변화 봉우리 뒤 이만큼 더 모아서 사건을 만듦(초)
    this.backWin = opts.backWin ?? 1.0;    // 비교 기준: 봉우리보다 창 길이 × 이만큼 앞의 소리
    this.lastThr = Infinity; this.prevT = 0; this.prevLoud = false;
    this.sens = opts.sens ?? 1.6;          // 문턱 = 최근 변화량(pct 백분위) × sens
    this.pct = opts.pct ?? 0.5;
    this.rel = opts.rel ?? 0.12;           // 문턱 하한 = 지금 울리는 소리 전체 × rel
    this.level = 0;                        // 화면 표시용 (0~1)
    // 반음 칸 중심 주파수
    this.f0 = new Float32Array(128).map((_, m) => 440 * Math.pow(2, (m - 69) / 12));
  }

  frame(samples, t) {
    const { n, re, im, win } = this;
    let energy = 0;
    const off = samples.length - n;
    for (let i = 0; i < n; i++) { const v = samples[off + i]; re[i] = v * win[i]; im[i] = 0; energy += v * v; }
    const rms = Math.sqrt(energy / n);
    fftInPlace(re, im);
    const half = n / 2, binHz = this.sr / n;
    const mag = re; // 재사용
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
    // 봉우리 → 반음 칸. 세기는 제곱근으로 눌러서 큰 저음이 혼자 이기지 않게
    const e = new Float32Array(128);
    const kMin = Math.max(2, Math.floor(50 / binHz)), kMax = Math.min(half - 2, Math.ceil(4200 / binHz));
    for (let k = kMin; k <= kMax; k++) {
      const m = mag[k];
      if (!(m > mag[k - 1] && m >= mag[k + 1])) continue;
      const a = mag[k - 1], c = mag[k + 1];
      const d = (0.5 * (a - c)) / (a - 2 * m + c || 1e-9);
      const f = (k + d) * binHz;
      const midi = 69 + 12 * Math.log2(f / 440);
      const mi = Math.round(midi);
      if (mi < LO || mi > HI) continue;
      const cents = Math.abs(midi - mi) * 100;
      if (cents > 40) continue; // 반음 사이에 걸친 봉우리(잡음)는 버림
      const w = cents <= 25 ? 1 : (40 - cents) / 15;
      const v = Math.sqrt((m - 0.25 * (a - c) * d) / n) * w;
      if (v > e[mi]) e[mi] = v;
    }
    // 소리 크기 기준 갱신
    this.peakLevel = Math.max(rms, this.peakLevel * 0.997);
    if (rms < this.floor) this.floor = rms; else this.floor += (rms - this.floor) * 0.002;
    this.level = Math.min(1, rms / (this.peakLevel || 1));
    const loud = rms > Math.max(this.floor * 2.5, this.peakLevel * 0.02, 2e-4);

    // 변화량: 약 50ms 전 프레임보다 커진 만큼의 합
    const ref = this.refFrame(t - 0.05);
    let flux = 0;
    if (ref) for (let m = LO; m <= HI; m++) { const dlt = e[m] - ref.e[m]; if (dlt > 0) flux += dlt; }
    this.hist.push({ t, e });
    while (this.hist.length && this.hist[0].t < t - 0.5) this.hist.shift();
    this.fluxHist.push(flux);
    if (this.fluxHist.length > 40) this.fluxHist.shift();
    const sorted = [...this.fluxHist].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length * this.pct)] || 0;
    let total = 0;
    for (let m = LO; m <= HI; m++) total += e[m];
    const thr = Math.max(med * this.sens, total * this.rel, 1e-6);

    let out = null;
    // 모으던 사건 완성: 친 순간 이전 소리(before)보다 커진 만큼만 모은다
    if (this.pending && t >= this.pending.emitAt) {
      const p = this.pending;
      const chroma = new Float32Array(12);
      let s = 0;
      for (let m = LO; m <= HI; m++) {
        const dlt = e[m] - p.before[m];
        if (dlt > 0) { chroma[m % 12] += dlt; s += dlt; }
      }
      this.pending = null;
      if (s > 0) {
        let nn = 0;
        for (const x of chroma) nn += x * x;
        nn = Math.sqrt(nn);
        for (let i = 0; i < 12; i++) chroma[i] /= nn;
        out = { t: p.t, chroma, strength: s };
      }
    }
    // 새로 친 순간 = 변화량이 문턱을 넘은 봉우리 (올라가다 내려가기 시작한 프레임)
    const prevFlux = this.lastFlux;
    const prevThr = this.lastThr;
    if (this.prevLoud && prevFlux > prevThr && flux < prevFlux && t - this.lastOnset >= this.minGap && !this.pending) {
      const tp = this.prevT;
      const win = this.n / this.sr;
      const before = (this.refFrame(tp - win * this.backWin) || { e: new Float32Array(128) }).e;
      this.pending = { t: tp - win * 0.6, before, emitAt: tp + this.collect };
      this.lastOnset = t;
    }
    this.lastFlux = flux; this.lastThr = thr; this.prevT = t; this.prevLoud = loud;
    this.e = e;
    return out;
  }

  refFrame(tt) {
    let r = null;
    for (const h of this.hist) { if (h.t <= tt) r = h; else break; }
    return r;
  }
}

/**
 * 마이크 켜기·끄기. onEvent(사건)으로 연주 사건을 넘긴다.
 *  - 메트로놈과 같은 AudioContext를 쓴다.
 *  - 소리를 스피커로 내보내지 않는다(0배 볼륨으로만 연결: 사파리가 처리를 멈추지 않게).
 */
export class MicListener {
  constructor(onEvent, { fakeUrl } = {}) {
    this.onEvent = onEvent;
    this.fakeUrl = fakeUrl;
    this.stream = null;
    this.timer = 0;
    this.nodes = [];
    this.analyzer = null;
  }
  get on() { return !!this.stream; }

  async start() {
    if (this.stream) return;
    if (!this.fakeUrl && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) throw Object.assign(new Error('nomic'), { code: 'unsupported' });
    const ac = audioContext({ record: !this.fakeUrl });
    let src;
    if (this.fakeUrl) {
      // 개발 시험용: 마이크 대신 녹음 파일을 소리 없이 흘려 넣음 (?fake=주소)
      const buf = await ac.decodeAudioData(await (await fetch(this.fakeUrl)).arrayBuffer());
      src = ac.createBufferSource();
      src.buffer = buf;
      src.start();
      this.stream = { getTracks: () => [{ stop: () => { try { src.stop(); } catch (e) { /* 무시 */ } } }] };
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      this.stream = stream;
      src = ac.createMediaStreamSource(stream);
    }
    if (ac.state !== 'running') { try { await ac.resume(); } catch (e) { /* suspended 로 확인 */ } }
    const an = ac.createAnalyser();
    this.analyzer = new OnsetChroma(ac.sampleRate);
    an.fftSize = this.analyzer.n;
    an.smoothingTimeConstant = 0;
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(an);
    an.connect(mute).connect(ac.destination);
    this.nodes = [src, an, mute];
    const buf = new Float32Array(an.fftSize);
    this.timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      const ev = this.analyzer.frame(buf, ac.currentTime);
      if (ev && this.onEvent) this.onEvent(ev);
    }, 16);
  }

  /** 오디오가 멈춰 있는지 (아이패드에서 다른 앱 갔다 오면 생김) */
  get suspended() { const ac = audioContext({ create: false }); return !ac || ac.state !== 'running'; }

  stop() {
    clearInterval(this.timer);
    for (const nd of this.nodes) { try { nd.disconnect(); } catch (e) { /* 무시 */ } }
    this.nodes = [];
    if (this.stream) for (const tr of this.stream.getTracks()) tr.stop();
    this.stream = null;
    if (!this.fakeUrl) audioContext({ record: false, create: false });
  }
}
