import { el } from './dom';

/**
 * 开场演出：一张标题卡 + 镜头推近。
 *
 * 目的：第一次打开时给"抵达一座小镇"的仪式感。
 * 只在首次进入播放（设备级标记），并且点击任意处可跳过——
 * 对休闲玩家来说，仪式感不能被体验成"等待"。
 */
export function playIntro(onDone?: () => void): void {
  const wrap = el('div', 'intro');
  const card = el('div', 'intro-card');
  card.appendChild(el('div', 'intro-title', '云上小镇'));
  card.appendChild(el('div', 'intro-sub', '一座会自己生长的小镇'));
  card.appendChild(el('div', 'intro-hint', '点击任意处开始'));
  wrap.appendChild(card);
  document.getElementById('ui')?.appendChild(wrap);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    wrap.classList.add('out');
    window.setTimeout(() => {
      wrap.remove();
      onDone?.();
    }, 700);
  };
  wrap.addEventListener('pointerdown', finish);
  window.setTimeout(finish, 2600);
}
