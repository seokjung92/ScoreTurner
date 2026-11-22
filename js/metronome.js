// 메트로놈: Web Audio로 정확한 박을 미리 예약해 친다 (화면이 바빠도 박이 밀리지 않게)

import { audioContext } from './audio.js';

let ctx = null;

function audio() {
  ctx = audioContext();
  return ctx;
}

export class Metronome {
  constructor(onBeat) {
    this.bpm = 80;
    this.running = false;
    this.onBeat = onBeat; // 박마다 화면 표시용 (beatIndex)
    this.timer = 0;
    this.next = 0;
    this.count = 0;
    this.pending = [];
    this.raf = 0;
  }

  setBpm(b) {
    this.bpm = Math.max(20, Math.min(300, Math.round(b)));
  }

  start() {
    if (this.running) return;
    const ac = audio();
    this.running = true;
    this.count = 0;
    this.next = ac.currentTime + 0.08;
    const tick = () => {
      // 0.12초 앞까지 박을 예약
      while (this.next < ac.currentTime + 0.12) {
        this.click(this.next);
        this.pending.push({ t: this.next, i: this.count });
        this.count++;
        this.next += 60 / this.bpm;
      }
    };
    tick();
    this.timer = setInterval(tick, 25);
    const draw = () => {
      if (!this.running) return;
      while (this.pending.length && this.pending[0].t <= ac.currentTime) {
        const b = this.pending.shift();
        if (this.onBeat) this.onBeat(b.i);
      }
      this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.pending = [];
  }

  click(t) {
    const ac = ctx;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.value = 1500;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + 0.06);
  }
}

// ---------- 추천 BPM ----------
// 빠르기말 → 대표 BPM (보통 쓰는 범위의 가운데쯤)
const TERMS = [
  [/grave/i, 40, 'Grave'], [/largo/i, 50, 'Largo'], [/lento/i, 56, 'Lento'], [/larghetto/i, 63, 'Larghetto'],
  [/adagietto/i, 72, 'Adagietto'], [/adagio/i, 66, 'Adagio'], [/andantino/i, 84, 'Andantino'], [/andante/i, 76, 'Andante'],
  [/moderato/i, 108, 'Moderato'], [/allegretto/i, 112, 'Allegretto'], [/allegro/i, 132, 'Allegro'],
  [/vivace/i, 156, 'Vivace'], [/presto/i, 180, 'Presto'],
  [/ballad/i, 72, 'Ballad'], [/slow/i, 66, 'Slow'], [/medium/i, 100, 'Medium'], [/fast/i, 140, 'Fast'],
];

/**
 * 악보 PDF의 글자에서 템포 표시를 찾는다. 돌려주는 값: { bpm, source }
 *  - "♩ = 95", "= 120", "BPM 100" 같은 숫자 표시 우선, 없으면 빠르기말, 둘 다 없으면 80
 */
export async function suggestBpm(doc) {
  let text = '';
  try {
    for (let p = 1; p <= Math.min(2, doc.numPages); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      text += ' ' + tc.items.map((it) => it.str).join(' ');
    }
  } catch (e) { /* 글자 층이 없는 PDF */ }
  const t = text.replace(/\s+/g, ' ');
  const num = [
    /(?:♩|♪|𝅘𝅥|\bq\b|\bJ\b||)\s*\.?\s*[=＝]\s*(?:c\.\s*|ca\.\s*|약\s*)?(\d{2,3})/,
    /(?:bpm|BPM|Bpm)\s*[=:]?\s*(\d{2,3})|(\d{2,3})\s*(?:bpm|BPM)/,
    /[=＝]\s*(?:c\.\s*|ca\.\s*)?(\d{2,3})\b/,
  ];
  for (const re of num) {
    const m = t.match(re);
    if (m) {
      const v = parseInt(m[1] || m[2], 10);
      if (v >= 30 && v <= 240) return { bpm: v, source: `악보의 템포 표시 (${m[0].trim()})` };
    }
  }
  for (const [re, v, name] of TERMS) {
    if (re.test(t)) return { bpm: v, source: `악보의 빠르기말 ${name} → 보통 ${v} 정도` };
  }
  if (!t.trim()) return { bpm: 80, source: '이 PDF는 글자가 그림으로 들어 있어 템포 표시를 읽을 수 없어요. 보통 빠르기 80으로 시작하니, 악보에 적힌 숫자를 직접 입력하세요' };
  return { bpm: 80, source: '악보에서 템포 표시를 못 찾아 보통 빠르기 80' };
}
