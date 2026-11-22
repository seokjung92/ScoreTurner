// 첫 사용 안내 (게임 튜토리얼처럼): 주변을 어둡게 하고 해당 버튼·영역만 테두리로 밝혀 설명을 띄운다.
//  steps: [{ target: () => Element | {left, top, width, height} | null, title, text, point?: 'safari-share' }]

let active = null;

export function isTourOpen() { return !!active; }

export function runTour(steps, { onDone } = {}) {
  if (active) active.close(false);
  steps = steps.filter((s) => !s.when || s.when());
  if (!steps.length) { if (onDone) onDone(); return; }
  let i = 0;
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = `
    <div class="tour-shade"></div>
    <div class="tour-hole"></div>
    <div class="tour-point" hidden><span>⬆</span><b>공유 버튼</b></div>
    <div class="tour-card" role="dialog" aria-live="polite">
      <div class="tour-step"></div>
      <h3 class="tour-title"></h3>
      <p class="tour-text"></p>
      <div class="tour-btns"><button class="link tour-skip">건너뛰기</button><span class="sp"></span><button class="btn tour-prev">이전</button><button class="btn primary tour-next">다음</button></div>
    </div>`;
  document.body.appendChild(root);
  const $ = (c) => root.querySelector(c);
  // 안내 중에는 뒤 화면이 눌리지 않게
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.addEventListener('pointerup', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => e.stopPropagation());

  const rectOf = (t) => {
    if (!t) return null;
    const v = typeof t === 'function' ? t() : t;
    if (!v) return null;
    if (v.getBoundingClientRect) {
      const r = v.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    return v;
  };

  const place = () => {
    const st = steps[i];
    $('.tour-step').textContent = `${i + 1} / ${steps.length}`;
    $('.tour-title').textContent = st.title || '';
    $('.tour-text').innerHTML = st.text;
    $('.tour-prev').hidden = i === 0;
    $('.tour-next').textContent = i === steps.length - 1 ? '시작하기' : '다음';
    $('.tour-point').hidden = st.point !== 'safari-share';
    const r = rectOf(st.target);
    const hole = $('.tour-hole'), shade = $('.tour-shade'), card = $('.tour-card');
    const pad = st.pad ?? 8;
    if (r) {
      hole.hidden = false; shade.hidden = true;
      Object.assign(hole.style, {
        left: r.left - pad + 'px', top: r.top - pad + 'px',
        width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px',
      });
    } else {
      hole.hidden = true; shade.hidden = false;
    }
    // 카드 위치: 대상 아래에 자리가 있으면 아래, 아니면 위, 대상이 없으면 가운데
    card.style.left = card.style.top = '';
    const cw = Math.min(420, innerWidth - 32);
    card.style.width = cw + 'px';
    const ch = card.offsetHeight;
    let left, top;
    if (r) {
      left = Math.max(16, Math.min(innerWidth - cw - 16, r.left + r.width / 2 - cw / 2));
      const below = r.top + r.height + pad + 14;
      const above = r.top - pad - 14 - ch;
      if (below + ch < innerHeight - 12) top = below;
      else if (above > 12) top = above;
      else {
        // 위아래에 자리가 없으면 옆으로 (넓은 쪽)
        top = Math.max(12, Math.min(innerHeight - ch - 12, r.top + r.height / 2 - ch / 2));
        const leftSpace = r.left - pad - 14, rightSpace = innerWidth - (r.left + r.width + pad + 14);
        if (rightSpace >= leftSpace && rightSpace >= Math.min(cw, 260)) {
          left = r.left + r.width + pad + 14;
          card.style.width = Math.min(cw, rightSpace - 12) + 'px';
        } else if (leftSpace >= Math.min(cw, 260)) {
          const w = Math.min(cw, leftSpace - 12);
          card.style.width = w + 'px';
          left = r.left - pad - 14 - w;
        } else {
          top = Math.max(12, (innerHeight - ch) / 2);
        }
      }
    } else {
      left = (innerWidth - cw) / 2;
      top = st.point === 'safari-share' ? 110 : Math.max(12, (innerHeight - ch) / 2);
    }
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  };

  const close = (done) => {
    removeEventListener('resize', place);
    root.remove();
    active = null;
    if (done !== false && onDone) onDone();
  };
  $('.tour-next').addEventListener('click', () => { if (i < steps.length - 1) { i++; place(); } else close(true); });
  $('.tour-prev').addEventListener('click', () => { if (i > 0) { i--; place(); } });
  $('.tour-skip').addEventListener('click', () => close(true));
  addEventListener('resize', place);
  active = { close };
  place();
}
