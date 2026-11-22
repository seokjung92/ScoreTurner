import * as lib from './library.js';
import { loadPdf, renderFit, thumbnail } from './pdfdoc.js';
import { Metronome, suggestBpm } from './metronome.js';
import { InkStore, attachInk } from './ink.js';
import { runTour, isTourOpen } from './tour.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('st.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('st.' + k, JSON.stringify(v)); } catch (e) { /* 무시 */ } },
};
const params = new URLSearchParams(location.search);
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || params.get('ios') === '1';
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ---------------- 공통 ----------------
let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  const d = Math.floor(s / 86400);
  if (d === 1) return '어제';
  if (d < 30) return d + '일 전';
  return new Date(ts).toLocaleDateString('ko-KR');
}

// ---------------- 서재 ----------------
let tab = store.get('tab', 'recent');
const thumbUrls = new Map();

async function importFiles(files) {
  const pdfs = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) { toast('PDF 파일만 넣을 수 있습니다'); return; }
  let added = 0, dup = 0, bad = 0;
  for (const f of pdfs) {
    toast(`가져오는 중… ${added + dup + bad + 1} / ${pdfs.length}`, 60000);
    const meta = await lib.addScore(f);
    if (!meta) { dup++; continue; }
    try {
      const doc = await loadPdf(f);
      meta.pages = doc.numPages;
      meta.thumb = await thumbnail(doc);
      await doc.destroy();
      await lib.putScore(meta);
      added++;
    } catch (e) {
      console.error(e);
      await lib.deleteScore(meta.id);
      bad++;
    }
  }
  lib.askPersist();
  const parts = [];
  if (added) parts.push(`${added}개 넣음`);
  if (dup) parts.push(`${dup}개는 이미 있음`);
  if (bad) parts.push(`${bad}개는 열 수 없는 PDF`);
  toast(parts.join(' · '));
  if (added && tab === 'recent') setTab('all');
  else renderLibrary();
}

function setTab(t) {
  tab = t;
  store.set('tab', t);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  renderLibrary();
}

async function renderLibrary() {
  const all = await lib.listScores();
  $('countAll').textContent = all.length ? `(${all.length})` : '';
  const q = $('search').value.trim().toLowerCase();
  let list = all.filter((m) => !q || m.name.toLowerCase().includes(q));
  if (tab === 'recent') {
    list = list.filter((m) => m.opened).sort((a, b) => b.opened - a.opened).slice(0, 30);
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  const grid = $('grid');
  grid.textContent = '';
  $('empty').hidden = all.length > 0;
  if (all.length && !list.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = q ? '찾는 이름의 악보가 없습니다' : '아직 연 악보가 없습니다. "전체"에서 골라 보세요.';
    grid.appendChild(p);
    grid.style.display = 'block';
    return;
  }
  grid.style.display = '';
  for (const m of list) grid.appendChild(card(m));
}

function card(m) {
  const el = document.createElement('div');
  el.className = 'card';
  const th = document.createElement('div');
  th.className = 'thumb';
  if (m.thumb) {
    let url = thumbUrls.get(m.id);
    if (!url) { url = URL.createObjectURL(m.thumb); thumbUrls.set(m.id, url); }
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    th.appendChild(img);
  } else {
    th.innerHTML = '<span class="ph">♪</span>';
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = m.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  const bits = [];
  if (m.pages) bits.push(`${m.pages}쪽`);
  if (m.opened) bits.push(`${m.page}쪽까지 · ${ago(m.opened)}`);
  sub.textContent = bits.join(' · ');
  meta.append(name, sub);
  const more = document.createElement('button');
  more.className = 'more';
  more.textContent = '⋯';
  more.setAttribute('aria-label', '더 보기');
  more.addEventListener('click', (e) => { e.stopPropagation(); cardMenu(m, more); });
  el.append(th, meta, more);
  el.addEventListener('click', () => openScore(m.id));
  return el;
}

function closeMenus() { document.querySelectorAll('.menu').forEach((x) => x.remove()); }

function cardMenu(m, anchor) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu';
  const add = (label, fn, cls) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', () => { closeMenus(); fn(); });
    menu.appendChild(b);
  };
  add('이름 바꾸기', async () => {
    const n = prompt('새 이름', m.name);
    if (n && n.trim()) { await lib.updateScore(m.id, { name: n.trim() }); renderLibrary(); }
  });
  if (m.opened) add('최근 목록에서 빼기', async () => { await lib.updateScore(m.id, { opened: 0 }); renderLibrary(); });
  add('삭제', async () => {
    if (!confirm(`"${m.name}"을(를) 이 앱에서 지울까요?\n메모도 함께 지워집니다. 파일 앱의 원본 PDF는 그대로 있습니다.`)) return;
    await lib.deleteScore(m.id);
    const u = thumbUrls.get(m.id);
    if (u) { URL.revokeObjectURL(u); thumbUrls.delete(m.id); }
    renderLibrary();
  }, 'danger');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  menu.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}

// ---------------- 악보 보기 ----------------
const V = {
  meta: null, doc: null, page: 1, perView: 1,
  cache: new Map(), // key → Promise<canvas>
  wake: null, barTimer: 0, showing: 0,
  ink: null, inkLayers: [], memo: false, tool: store.get('inkTool', 'black'),
  suggest: null,
};
let layoutMode = store.get('layout', 'auto'); // auto | 1 | 2

function perViewNow() {
  if (layoutMode === '1') return 1;
  if (layoutMode === '2') return 2;
  return innerWidth > innerHeight * 1.15 ? 2 : 1;
}

function boxSize() {
  const pad = 6;
  const w = innerWidth - pad * 2, h = innerHeight - pad * 2;
  return V.perView === 2 ? [(w - 4) / 2, h] : [w, h];
}

function cacheKey(n) {
  const [w, h] = boxSize();
  return `${n}@${Math.round(w)}x${Math.round(h)}@${devicePixelRatio}`;
}

function getCanvas(n) {
  const k = cacheKey(n);
  if (!V.cache.has(k)) {
    const [w, h] = boxSize();
    V.cache.set(k, renderFit(V.doc, n, w, h, devicePixelRatio || 1).then((c) => { c.classList.add('page'); return c; }));
  }
  return V.cache.get(k);
}

function trimCache() {
  const keep = new Set();
  for (let n = V.page - V.perView; n < V.page + V.perView * 2; n++) if (n >= 1 && n <= V.doc.numPages) keep.add(cacheKey(n));
  for (const [k, p] of V.cache) {
    if (!keep.has(k)) {
      V.cache.delete(k);
      p.then((c) => { if (!c.isConnected) { c.width = 0; c.height = 0; } }).catch(() => {});
    }
  }
}

async function showPage(n, opts = {}) {
  if (!V.doc) return;
  const total = V.doc.numPages;
  V.perView = perViewNow();
  // 두 쪽 보기에서는 홀수 쪽이 왼쪽 (1-2, 3-4 …)
  if (V.perView === 2) n = n - ((n - 1) % 2);
  n = Math.max(1, Math.min(total, n));
  V.page = n;
  const ticket = ++V.showing;
  const nums = [];
  for (let i = 0; i < V.perView && n + i <= total; i++) nums.push(n + i);
  const canvases = await Promise.all(nums.map(getCanvas));
  if (ticket !== V.showing) return;
  const box = $('pages');
  box.textContent = '';
  V.inkLayers = [];
  canvases.forEach((c, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'pagewrap';
    wrap.appendChild(c);
    box.appendChild(wrap);
    if (V.ink) V.inkLayers.push(attachInk(wrap, c, nums[i], V.ink, { isActive: () => V.memo, tool: () => V.tool }));
  });
  const last = nums[nums.length - 1];
  const label = nums.length > 1 ? `${n}–${last} / ${total}` : `${n} / ${total}`;
  $('pageNum').textContent = label;
  $('pageBadge').textContent = label;
  if (opts.flash) flash(opts.flash);
  lib.updateScore(V.meta.id, { page: n });
  // 다음 쪽 미리 그리기
  for (let i = 0; i < V.perView; i++) if (last + 1 + i <= total) getCanvas(last + 1 + i);
  if (n > 1) getCanvas(Math.max(1, n - V.perView));
  trimCache();
}

function turn(dir) {
  if (!V.doc) return;
  const total = V.doc.numPages;
  const next = V.page + dir * V.perView;
  if (next < 1 || next > total) {
    toast(dir > 0 ? '마지막 쪽입니다' : '첫 쪽입니다', 1200);
    return;
  }
  showPage(next, { flash: dir > 0 ? 'right' : 'left' });
}

function flash(side) {
  const f = document.createElement('div');
  f.className = 'flash';
  f.style[side] = '0';
  $('viewer').appendChild(f);
  setTimeout(() => f.remove(), 300);
}

function showBar(on, autoHideMs = 0) {
  $('vbar').classList.toggle('off', !on);
  clearTimeout(V.barTimer);
  if (on && autoHideMs) V.barTimer = setTimeout(() => { if (!isTourOpen() && $('metroPanel').hidden) showBar(false); }, autoHideMs);
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !$('viewer').hidden) {
      V.wake = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* 지원 안 하면 무시 */ }
}

function layoutLabel() {
  return layoutMode === 'auto' ? '자동' : layoutMode === '1' ? '한 쪽' : '두 쪽';
}

async function openScore(id) {
  const meta = await lib.getScore(id);
  const blob = await lib.getFile(id);
  if (!meta || !blob) { toast('악보 파일을 찾을 수 없습니다'); return; }
  let doc;
  try { doc = await loadPdf(blob); } catch (e) { toast('PDF를 열 수 없습니다'); return; }
  V.meta = await lib.updateScore(id, { opened: Date.now(), pages: doc.numPages });
  V.doc = doc;
  V.cache.clear();
  V.ink = await new InkStore(id).load();
  V.suggest = null;
  setMemo(false);
  $('vtitle').textContent = meta.name;
  $('layoutBtn').textContent = layoutLabel();
  $('library').hidden = true;
  $('viewer').hidden = false;
  history.pushState({ view: 'viewer' }, '');
  keepAwake();
  await showPage(meta.page || 1);
  if (!store.get('tour.viewer', false)) viewerTour();
  else showBar(true, 2500);
}

async function closeViewer(fromPop = false) {
  if ($('viewer').hidden) return;
  metro.stop();
  updateMetroUi();
  $('metroPanel').hidden = true;
  setMemo(false);
  if (V.ink) await V.ink.flush();
  $('viewer').hidden = true;
  $('library').hidden = false;
  $('pages').textContent = '';
  V.cache.clear();
  if (V.doc) { V.doc.destroy(); V.doc = null; }
  try { if (V.wake) await V.wake.release(); } catch (e) { /* 무시 */ }
  V.wake = null;
  if (!fromPop) history.back();
  renderLibrary();
}

// ---------------- 메트로놈 ----------------
const metro = new Metronome(() => {
  const d = $('beatDot');
  d.classList.add('on');
  setTimeout(() => d.classList.remove('on'), 110);
});

function updateMetroUi() {
  $('metroStart').textContent = metro.running ? '■ 정지' : '▶ 시작';
  $('metroStart').classList.toggle('primary', !metro.running);
  $('metroPill').hidden = !metro.running;
  $('pillBpm').textContent = `♩ = ${metro.bpm}`;
  $('metroBtn').classList.toggle('active', metro.running);
}

function setBpm(v, save = true) {
  if (!Number.isFinite(v)) return;
  metro.setBpm(v);
  $('bpmInput').value = metro.bpm;
  updateMetroUi();
  if (save && V.meta) lib.updateScore(V.meta.id, { bpm: metro.bpm });
}

async function openMetro() {
  showBar(true);
  $('metroPanel').hidden = false;
  if (!V.suggest) {
    $('bpmSource').textContent = '악보에서 템포 표시를 찾는 중…';
    V.suggest = await suggestBpm(V.doc);
  }
  const meta = await lib.getScore(V.meta.id);
  const saved = meta && meta.bpm;
  $('bpmSource').textContent = saved && saved !== V.suggest.bpm
    ? `추천 ${V.suggest.bpm} (${V.suggest.source}) · 지난번에 쓴 값 ${saved}`
    : `추천 ${V.suggest.bpm}: ${V.suggest.source}`;
  if (!metro.running) setBpm(saved || V.suggest.bpm, false);
  updateMetroUi();
  if (!store.get('tour.metro', false)) {
    store.set('tour.metro', true);
    runTour([
      { target: () => $('bpmInput'), title: '빠르기(BPM) 입력', text: '악보의 템포 표시를 읽어 <b>추천 BPM</b>을 미리 넣어 두었어요. 숫자를 눌러 직접 입력하거나 − / + 로 1씩 바꿀 수 있어요.' },
      { target: () => $('bpmSource'), title: '추천 근거', text: '어디서 찾은 값인지 알려 줘요. 템포 표시가 없는 악보는 보통 빠르기 80으로 시작해요. 악보마다 마지막에 쓴 값을 기억해요.' },
      { target: () => $('metroStart'), title: '시작 / 정지', text: '시작하면 메뉴를 닫아도 계속 울려요. 왼쪽 아래의 작은 표시에서 <b>정지</b>를 누를 수 있어요.<br>※ 소리가 안 나면 아이패드 소리 크기를 확인하세요.' },
    ]);
  }
}

function setupMetro() {
  $('metroBtn').addEventListener('click', () => { if ($('metroPanel').hidden) openMetro(); else $('metroPanel').hidden = true; });
  $('metroClose').addEventListener('click', () => { $('metroPanel').hidden = true; showBar(true, 2000); });
  $('bpmMinus').addEventListener('click', () => setBpm(metro.bpm - 1));
  $('bpmPlus').addEventListener('click', () => setBpm(metro.bpm + 1));
  $('bpmSuggest').addEventListener('click', () => { if (V.suggest) setBpm(V.suggest.bpm); });
  $('bpmInput').addEventListener('change', () => setBpm(parseInt($('bpmInput').value, 10)));
  $('bpmInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { setBpm(parseInt($('bpmInput').value, 10)); $('bpmInput').blur(); } });
  $('metroStart').addEventListener('click', () => {
    setBpm(parseInt($('bpmInput').value, 10) || metro.bpm);
    if (metro.running) metro.stop(); else metro.start();
    updateMetroUi();
  });
  $('pillStop').addEventListener('click', (e) => { e.stopPropagation(); metro.stop(); updateMetroUi(); });
}

// ---------------- 메모 (애플 펜슬) ----------------
function setMemo(on) {
  V.memo = on;
  $('viewer').classList.toggle('memo', on);
  $('palette').hidden = !on;
  $('inkBtn').classList.toggle('active', on);
  document.querySelectorAll('.palette .tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === V.tool));
}

function redrawInk(page) {
  for (const l of V.inkLayers) if (page == null || l.page === page) l.redraw();
}

function setupInk() {
  $('inkBtn').addEventListener('click', () => {
    const on = !V.memo;
    setMemo(on);
    if (on) {
      showBar(false);
      if (!store.get('tour.ink', false)) {
        store.set('tour.ink', true);
        runTour([
          { target: null, title: '메모 모드', text: '<b>애플 펜슬</b>로 악보 위에 바로 쓰세요. 쓴 메모는 이 아이패드에 악보마다 저장돼요.<br>메모 중에는 <b>손가락으로 눌러도 쪽이 넘어가지 않아요</b> (손바닥이 닿아도 넘어가지 않게). 아래 도구의 <b>완료</b>를 누르거나, 넘김 페달을 쓰세요.' },
          { target: () => $('palette').querySelector('[data-tool="black"]').parentElement, title: '펜과 지우개', text: '검정·빨강·파랑 펜, 형광펜, 지우개를 고를 수 있어요. 지우개는 닿은 획을 통째로 지워요.' },
          { target: () => $('inkUndo'), title: '되돌리기 · 지우기', text: '<b>되돌리기</b>는 방금 한 것을 취소해요. <b>이 쪽 지우기</b>는 지금 쪽의 메모를 모두 지워요.' },
          { target: () => $('inkDone'), title: '완료', text: '메모를 마치면 <b>완료</b>를 누르세요. 다시 손가락으로 쪽을 넘길 수 있어요.' },
        ]);
      }
    } else showBar(true, 2000);
  });
  document.querySelectorAll('.palette .tool[data-tool]').forEach((b) => b.addEventListener('click', () => {
    V.tool = b.dataset.tool;
    store.set('inkTool', V.tool);
    setMemo(true);
  }));
  $('inkUndo').addEventListener('click', () => {
    const p = V.ink && V.ink.undoLast();
    if (p == null) { toast('되돌릴 것이 없습니다', 1200); return; }
    if (!V.inkLayers.some((l) => l.page === p)) showPage(p); else redrawInk(p);
  });
  $('inkClear').addEventListener('click', () => {
    let any = false;
    for (const l of V.inkLayers) any = V.ink.clear(l.page) || any;
    if (any) { redrawInk(); toast('이 쪽의 메모를 지웠습니다 (되돌리기 가능)', 1800); }
  });
  $('inkDone').addEventListener('click', () => { setMemo(false); showBar(true, 2000); });
}

// ---------------- 안내 (튜토리얼) ----------------
function libraryTour() {
  runTour([
    {
      when: () => isIOS && !isStandalone(), point: 'safari-share', target: null, title: '먼저, 홈 화면에 추가하세요',
      text: '사파리 위쪽의 <b>공유 버튼</b>(네모에 위 화살표)을 누르고 <b>"홈 화면에 추가"</b>를 고르세요. (공유 버튼이 안 보이면 주소창 옆 <b>···</b> 메뉴 안에 있어요)<br><br>그다음부터는 홈 화면의 <b>악보 넘김</b> 아이콘으로 여세요. 앱처럼 전체 화면으로 열리고, 넣어 둔 악보가 지워지지 않아요.<br>※ 사파리와 홈 화면 앱은 보관함이 따로라서, <b>악보는 홈 화면 아이콘으로 연 뒤에</b> 가져오세요.',
    },
    { target: () => $('importBtn'), title: 'PDF 가져오기', text: '파일 앱에서 악보 PDF를 고르세요. <b>여러 개를 한 번에</b> 고를 수 있어요.<br>한 번 넣은 악보는 이 아이패드 안에 계속 남고, 인터넷으로 보내지지 않아요.' },
    { target: () => $('tabs'), title: '최근 연 악보 · 전체', text: '최근에 본 악보가 먼저 보이고, 마지막으로 본 쪽부터 다시 열려요. <b>전체</b>에서는 이름 순으로 모두 보여요. 악보를 누르면 열려요.' },
    { target: () => $('helpBtn'), title: '안내 다시 보기', text: '이 <b>?</b> 버튼을 누르면 언제든 이 안내를 다시 볼 수 있어요.' },
  ], { onDone: () => store.set('tour.library', true) });
}

function viewerTour() {
  showBar(true);
  const zone = (a, b) => () => ({ left: innerWidth * a + 8, top: innerHeight * 0.18, width: innerWidth * (b - a) - 16, height: innerHeight * 0.64 });
  runTour([
    { target: zone(0.65, 1), title: '다음 쪽', text: '화면 <b>오른쪽</b>을 누르면 다음 쪽으로 넘어가요. 왼쪽으로 <b>밀어도</b> 넘어가요.' },
    { target: zone(0, 0.35), title: '이전 쪽', text: '화면 <b>왼쪽</b>을 누르면 이전 쪽으로 돌아가요. 오른쪽으로 밀어도 돼요.' },
    { target: zone(0.35, 0.65), title: '메뉴 보이기 · 숨기기', text: '<b>가운데</b>를 누르면 위쪽 메뉴가 나타나거나 사라져요. 연주할 때는 숨겨 두면 악보가 넓게 보여요.' },
    { target: null, title: '넘김 페달', text: '블루투스 <b>악보 넘김 페달</b>을 아이패드에 연결하면 발로도 넘길 수 있어요. (방향키·Page Down·스페이스를 보내는 페달이면 대부분 돼요)' },
    { target: () => $('metroBtn'), title: '메트로놈', text: '악보의 템포 표시를 읽어 추천 BPM을 넣어 줘요. 숫자를 눌러 직접 입력할 수 있어요.' },
    { target: () => $('inkBtn'), title: '메모 (애플 펜슬)', text: '누르면 메모 모드가 돼요. 애플 펜슬로 악보 위에 쓰고, 다 쓰면 <b>완료</b>를 누르세요.' },
    { target: () => $('layoutBtn'), title: '한 쪽 · 두 쪽', text: '<b>자동</b>은 세로일 때 한 쪽, 가로일 때 두 쪽을 보여 줘요. 누를 때마다 자동 → 한 쪽 → 두 쪽으로 바뀌어요.' },
    { target: () => $('vHelpBtn'), title: '안내 다시 보기', text: '<b>?</b>를 누르면 이 안내를 다시 볼 수 있어요.' },
  ], { onDone: () => { store.set('tour.viewer', true); showBar(true, 2500); } });
}

// 터치: 왼쪽 35% = 이전, 오른쪽 35% = 다음, 가운데 = 메뉴. 좌우로 밀면 넘김
function setupViewerInput() {
  const vw = $('viewer');
  let sx = 0, sy = 0, st = 0, active = false, multi = false;
  const ui = (e) => e.target.closest('.vbar, .panel, .pill, .palette, .tour');
  vw.addEventListener('pointerdown', (e) => {
    if (ui(e)) return;
    if (!e.isPrimary) { multi = true; return; }
    active = true; multi = false;
    sx = e.clientX; sy = e.clientY; st = performance.now();
  });
  vw.addEventListener('pointerup', (e) => {
    if (!active || !e.isPrimary) return;
    active = false;
    if (multi || isTourOpen()) return;
    // 메모 중에는 손으로 넘기지 않음 (손바닥 오작동 방지). 페달·◀▶·완료 사용
    if (V.memo) return;
    const dx = e.clientX - sx, dy = e.clientY - sy, dt = performance.now() - st;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { turn(dx < 0 ? 1 : -1); return; }
    if (Math.hypot(dx, dy) < 14 && dt < 600) {
      if (!$('metroPanel').hidden) { $('metroPanel').hidden = true; showBar(true, 2000); return; }
      const x = e.clientX / innerWidth;
      if (x < 0.35) turn(-1);
      else if (x > 0.65) turn(1);
      else showBar($('vbar').classList.contains('off'));
    }
  });
  vw.addEventListener('pointercancel', () => { active = false; });
  vw.addEventListener('contextmenu', (e) => e.preventDefault());
  // 사파리 확대 제스처 막기 (악보 넘김 중 실수로 확대되지 않게)
  document.addEventListener('gesturestart', (e) => { if (!$('viewer').hidden) e.preventDefault(); });

  // 블루투스 넘김 페달·키보드 (대부분 화살표·PageDown·스페이스를 보냄)
  document.addEventListener('keydown', (e) => {
    if ($('viewer').hidden || isTourOpen()) return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
    const prev = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];
    if (next.includes(e.key)) { e.preventDefault(); turn(1); }
    else if (prev.includes(e.key)) { e.preventDefault(); turn(-1); }
    else if (e.key === 'Escape') closeViewer();
  });

  $('backBtn').addEventListener('click', () => closeViewer());
  $('prevBtn').addEventListener('click', () => turn(-1));
  $('nextBtn').addEventListener('click', () => turn(1));
  $('vHelpBtn').addEventListener('click', () => viewerTour());
  $('layoutBtn').addEventListener('click', () => {
    layoutMode = layoutMode === 'auto' ? '1' : layoutMode === '1' ? '2' : 'auto';
    store.set('layout', layoutMode);
    $('layoutBtn').textContent = layoutLabel();
    V.cache.clear();
    showPage(V.page);
    showBar(true, 2500);
  });

  let rt = 0;
  addEventListener('resize', () => {
    if ($('viewer').hidden) return;
    clearTimeout(rt);
    rt = setTimeout(() => { V.cache.clear(); showPage(V.page); }, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
    else if (V.ink) V.ink.flush();
  });
  addEventListener('popstate', () => { if (!$('viewer').hidden) closeViewer(true); });
}

// ---------------- 시작 ----------------
function setupLibraryInput() {
  $('fileInput').addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) importFiles(files);
    e.target.value = '';
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('search').addEventListener('input', () => renderLibrary());
  $('helpBtn').addEventListener('click', () => libraryTour());
  // 맥·PC에서 끌어다 놓기
  addEventListener('dragover', (e) => { e.preventDefault(); });
  addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length && !$('library').hidden) importFiles(e.dataTransfer.files);
  });
}

setupLibraryInput();
setupViewerInput();
setupMetro();
setupInk();
setTab(tab);
if (!store.get('tour.library', false)) setTimeout(libraryTour, 400);

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !params.has('nosw')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
