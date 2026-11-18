// 配件大亂鬥 前端主程式：連線、鍵盤輸入、狀態插值、HUD；畫面交給 render3d.js
import * as R from './render3d.js';

const { GEAR_INFO } = R;
const COLORS = ['#ff7a3d', '#ffd23d', '#4ade80', '#38bdf8', '#818cf8', '#f472b6', '#f87171', '#e5e7eb'];
const KEYMAP = { ArrowUp: 'u', ArrowDown: 'd', ArrowLeft: 'l', ArrowRight: 'r', KeyZ: 'z', KeyX: 'x', KeyC: 'c', KeyV: 'v' };
const INTERP_MS = 70; // 伺服器 30 次/秒廣播，保留約兩筆的緩衝

const $ = (id) => document.getElementById(id);

let ws = null;
let myId = null;
let joined = false;
let ping = 0;
let lastFrame = performance.now();
const snaps = [];
const keys = { u: false, d: false, l: false, r: false, z: false, x: false, c: false, v: false };

// 讀取上次的名稱/配件/顏色設定
const setup = { name: '', gear: 'flame', color: COLORS[0], ch: '' };
try { Object.assign(setup, JSON.parse(localStorage.getItem('gearbrawl.setup') || '{}')); } catch (e) { /* 無法存取時用預設值 */ }

R.init($('game'), $('overlay'));
const preview = R.createPreview($('preview'));

/* ------------------------------------------------------------ 大廳 */

// 配件圖示（線條 SVG，顏色跟著 currentColor）
const SVG = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const GEAR_ICONS = {
  flame: SVG('<path d="M7 12V8.5a1.75 1.75 0 0 1 3.5 0V11M10.5 10V6.5a1.75 1.75 0 0 1 3.5 0V10M14 10V7.5a1.75 1.75 0 0 1 3.5 0V14a6 6 0 0 1-6 6h-1A5.5 5.5 0 0 1 5 14.5V12a1.75 1.75 0 0 1 3.5 0v1"/><path d="M12 2.5c.6 1 .2 1.8-.4 2.3"/>'),
  staff: SVG('<path d="M5 19 19 5"/><path d="M3.5 20.5 6 18M18 6l2.5-2.5"/><circle cx="12" cy="12" r="1.2"/>'),
  blaster: SVG('<path d="M3 8h12l2 2h4v4h-5l-2 2v3h-4v-5H3z"/><path d="M7 11h4"/>'),
  greatsword: SVG('<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="M13 19l6-6M16 16l4 4M19 21l2-2"/>'),
  axe: SVG('<path d="m14 12-8.5 8.5a2.12 2.12 0 1 1-3-3L11 9"/><path d="M15 13 9 7l4-4 6 6h3a8 8 0 0 1-7 7z"/>'),
  dagger: SVG('<path d="M20 4 12 12"/><path d="M20 4h0v3l-7 7-3-3 7-7z"/><path d="M8.5 12.5l3 3M7 17l-3 3"/>'),
  wand: SVG('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5"/>'),
};
const COLOR_NAMES = ['橘', '黃', '綠', '天藍', '紫', '粉紅', '紅', '白'];

// 建立大廳：角色、配件、顏色都是可用方向鍵切換的單選群組
function buildLobby() {
  $('name').value = setup.name;
  const list = R.characterList();
  if (list.length && !list.some((c) => c.key === setup.ch)) setup.ch = list[0].key;
  if (!GEAR_INFO[setup.gear]) setup.gear = 'flame';

  fillGroup($('chars'), list.map((c) => ({ key: c.key, cls: 'char-tile', label: c.name,
    html: `<span class="zh">${esc(c.name)}</span><span class="en">${esc(c.en)}</span>` })),
    () => setup.ch, (k) => { setup.ch = k; });
  fillGroup($('gears'), Object.entries(GEAR_INFO).map(([key, g]) => ({ key, cls: 'gear-tile', label: g.name,
    style: `--c:${g.color}`, html: `${GEAR_ICONS[key] || ''}<span>${g.name}</span>` })),
    () => setup.gear, (k) => { setup.gear = k; });
  fillGroup($('colors'), COLORS.map((c, i) => ({ key: c, cls: 'sw', label: COLOR_NAMES[i], style: `background:${c}`, html: '' })),
    () => setup.color, (k) => { setup.color = k; });
  refreshLobby();
}

// 產生一組單選按鈕（role=radio），支援點擊與方向鍵切換
function fillGroup(box, items, getSel, setSel) {
  box.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = it.cls;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', it.label);
    b.dataset.key = it.key;
    if (it.style) b.style.cssText = it.style;
    b.innerHTML = it.html;
    b.onclick = () => { setSel(it.key); refreshLobby(); };
    box.appendChild(b);
  }
  box.onkeydown = (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const btns = [...box.children];
    const i = btns.findIndex((x) => x.dataset.key === getSel());
    const next = btns[(i + dir + btns.length) % btns.length];
    setSel(next.dataset.key);
    refreshLobby();
    next.focus();
  };
  box.dataset.ready = '1';
  box._getSel = getSel;
}

// 依目前選擇更新：選取狀態、主題色、舞台文字、配件詳細資料
function refreshLobby() {
  for (const box of [$('chars'), $('gears'), $('colors')]) {
    const sel = box._getSel ? box._getSel() : null;
    for (const b of box.children) {
      const on = b.dataset.key === sel;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1; // 群組內只有選中的那顆可 Tab 到，其餘用方向鍵
    }
  }
  const g = GEAR_INFO[setup.gear];
  const ch = R.characterList().find((c) => c.key === setup.ch);
  $('lobby').style.setProperty('--gear', g.color);
  $('stageChar').textContent = ch ? ch.name : '';
  $('stageEn').textContent = ch ? ch.en : '';
  $('stageGear').innerHTML = `${GEAR_ICONS[setup.gear] || ''}${esc(g.name)}`;
  const pips = (n) => `<span class="pips">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
  const [pw, rg, sp] = g.stats;
  $('gearDetail').innerHTML = `
    <div>
      <div class="gd-name">${GEAR_ICONS[setup.gear] || ''}${esc(g.name)}</div>
      <span class="gd-tag">${esc(g.tag)}</span>
      <div class="stat" aria-label="威力 ${pw} / 5"><span>威力</span>${pips(pw)}</div>
      <div class="stat" aria-label="距離 ${rg} / 5"><span>距離</span>${pips(rg)}</div>
      <div class="stat" aria-label="速度 ${sp} / 5"><span>速度</span>${pips(sp)}</div>
    </div>
    <ul class="moves">
      <li><span class="keys"><kbd>X</kbd></span><span>${esc(g.light)}</span></li>
      <li><span class="keys"><kbd>C</kbd></span><span>${esc(g.heavy)}</span></li>
      <li class="ult"><span class="keys"><kbd>Z</kbd><kbd>X</kbd><kbd>C</kbd></span><span><b>${esc(g.ult[0])}</b>・${esc(g.ult[1])}</span></li>
    </ul>`;
}

// 按下「進入競技場」：存設定並送出加入請求
function startGame() {
  setup.name = $('name').value.trim();
  try { localStorage.setItem('gearbrawl.setup', JSON.stringify(setup)); } catch (e) { /* 忽略 */ }
  const join = () => send({ t: 'join', name: setup.name, gear: setup.gear, color: setup.color, ch: setup.ch });
  if (ws && ws.readyState === WebSocket.OPEN) join();
  else connect(join);
  showLobby(false);
}

// 顯示或隱藏大廳（顯示時放開所有按鍵）
function showLobby(show) {
  $('lobby').classList.toggle('hidden', !show);
  $('start').querySelector('span').textContent = joined ? '確定換裝' : '進入競技場';
  $('backBtn').classList.toggle('hidden', !joined);
  if (show) { releaseAll(); $('start').focus({ preventScroll: true }); }
}

/* ------------------------------------------------------------ 連線 */

// 建立 WebSocket 連線，連上後執行 onOpen
function connect(onOpen) {
  $('status').textContent = '連線中…';
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { $('status').textContent = ''; if (onOpen) onOpen(); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    joined = false;
    $('hud').classList.add('hidden');
    $('status').textContent = '與伺服器的連線中斷了，按下按鈕重新連線。';
    showLobby(true);
  };
}

// 送出訊息給伺服器
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// 處理伺服器訊息
function onMessage(m) {
  if (m.t === 'welcome') {
    myId = m.id;
    R.setMap(m.map);
    joined = true;
    $('hud').classList.remove('hidden');
  } else if (m.t === 's') {
    snaps.push({ at: performance.now(), s: m });
    while (snaps.length > 2 && performance.now() - snaps[0].at > 1000) snaps.shift();
    for (const f of m.fx) onFx(f);
    updateHud(m);
  } else if (m.t === 'pong') {
    ping = Math.round(performance.now() - m.ts);
  }
}

// 伺服器事件：畫面特效交給 3D 模組，文字訊息顯示在上方
function onFx(f) {
  R.fx(f);
  if (f.k === 'ko') feed(f.by ? `<b style="color:${f.color}">${esc(f.by)}</b> KO 了 ${esc(f.name)}` : `${esc(f.name)} 掉出場外了`);
  else if (f.k === 'join') feed(`${esc(f.name)} 加入了戰局`);
  else if (f.k === 'leave') feed(`${esc(f.name)} 離開了`);
  else if (f.k === 'start') feed('新的一局開始！');
}

/* ------------------------------------------------------------ 輸入 */

// 鍵盤按下：更新按鍵狀態並立即送出
addEventListener('keydown', (e) => {
  if ($('helpDlg').open) return; // 說明視窗開著時交給對話框處理（Esc 會自己關閉）
  if (e.code === 'Escape' && joined) { showLobby($('lobby').classList.contains('hidden')); return; }
  if (!$('lobby').classList.contains('hidden')) {
    // 焦點在按鈕上時 Enter 交給按鈕本身（避免選配件時直接開打）；在輸入框或空白處才代表開始
    if (e.code === 'Enter' && !(e.target instanceof HTMLButtonElement)) startGame();
    return;
  }
  const k = KEYMAP[e.code];
  if (!k) return;
  e.preventDefault();
  if (!keys[k]) { keys[k] = true; sendKeys(); }
});

// 鍵盤放開
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k && keys[k]) { keys[k] = false; sendKeys(); }
});
addEventListener('blur', () => releaseAll());

// 放開所有按鍵（切視窗或開選單時避免角色一直跑）
function releaseAll() {
  for (const k in keys) keys[k] = false;
  sendKeys();
}

// 把目前按鍵狀態送給伺服器
function sendKeys() {
  if (joined) send({ t: 'input', k: keys });
}
setInterval(sendKeys, 250);
setInterval(() => send({ t: 'ping', ts: performance.now() }), 2000);

/* ------------------------------------------------------------ HUD */

// 畫面上方的擊殺/系統訊息
function feed(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  $('feed').prepend(el);
  setTimeout(() => { el.style.opacity = '0'; }, 3500);
  setTimeout(() => el.remove(), 4000);
  while ($('feed').children.length > 5) $('feed').lastChild.remove();
}

// 跳脫 HTML，避免玩家名稱塞入標籤
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 更新計時、排行榜、自己的血量與冷卻、陣亡提示、結算畫面
function updateHud(s) {
  const m = Math.floor(s.tl / 60);
  $('timer').textContent = `${m}:${String(s.tl % 60).padStart(2, '0')}`;
  const sorted = [...s.p].sort((a, b) => b.k - a.k || a.de - b.de);
  $('board').innerHTML = sorted.map((p) =>
    `<div class="row${p.id === myId ? ' self' : ''}"><span class="dot" style="background:${p.c}"></span>` +
    `<span class="nm">${esc(p.n)}</span><span class="sc">${p.k} / ${p.de}</span></div>`).join('') +
    `<div class="row" style="color:#9aa7c7;font-size:12px;margin-top:4px">KO / 被 KO　·　延遲 ${ping}ms</div>`;
  const me = s.p.find((p) => p.id === myId);
  if (me) {
    const g = GEAR_INFO[me.g];
    $('meName').innerHTML = `<span style="color:${me.c}">●</span> ${esc(me.n)}`;
    $('meHp').style.width = me.hp + '%';
    $('meHp').style.background = me.hp > 50 ? '#4ade80' : me.hp > 25 ? '#facc15' : '#f87171';
    $('meGear').textContent = g.name;
    $('meGear').style.color = g.color;
    $('meCd').style.width = Math.round((1 - me.cd) * 100) + '%';
    $('meCd').style.opacity = me.cd > 0 ? 0.5 : 1;
    const dead = me.s === 'dead';
    $('koMsg').classList.toggle('hidden', !dead);
    if (dead) $('koMsg').textContent = `KO！${Math.max(0, Math.ceil(me.du - me.t))} 秒後重生`;
  }
  const res = $('result');
  if (s.ph === 'result') {
    if (res.classList.contains('hidden')) {
      const top = sorted[0];
      $('resultPanel').innerHTML = `<h2>本局結束 — 冠軍：<span class="win" style="color:${top ? top.c : '#fff'}">${top ? esc(top.n) : '-'}</span></h2><ol>` +
        sorted.map((p) => `<li>${esc(p.n)}　KO ${p.k}　被 KO ${p.de}</li>`).join('') + '</ol><p id="resultT"></p>';
      res.classList.remove('hidden');
    }
    $('resultT').textContent = `${s.rt} 秒後開始下一局`;
  } else {
    res.classList.add('hidden');
  }
}

/* ------------------------------------------------------------ 插值 */

// 線性插值
function lerp(a, b, t) { return a + (b - a) * t; }

// 取出「INTERP_MS 前」的平滑畫面狀態，讓移動不會一頓一頓
function viewState() {
  if (!snaps.length) return null;
  const rt = performance.now() - INTERP_MS;
  const last = snaps[snaps.length - 1];
  if (snaps.length < 2 || rt >= last.at) return last.s;
  let b = snaps.length - 1;
  while (b > 0 && snaps[b - 1].at > rt) b--;
  if (b === 0) return snaps[0].s;
  const A = snaps[b - 1].s;
  const B = snaps[b].s;
  const a = (rt - snaps[b - 1].at) / (snaps[b].at - snaps[b - 1].at);
  const mix = (listA, listB, extra) => {
    const m = new Map(listA.map((o) => [o.id, o]));
    return listB.map((o) => {
      const q = m.get(o.id);
      if (!q || Math.hypot(q.x - o.x, q.y - o.y) > 150) return o; // 重生瞬移不插值
      const r = { ...o, x: lerp(q.x, o.x, a), y: lerp(q.y, o.y, a), z: lerp(q.z, o.z, a) };
      if (extra) extra(q, o, r);
      return r;
    });
  };
  return {
    ...B,
    p: mix(A.p, B.p, (q, o, r) => { if (q.s === o.s && o.t >= q.t) r.t = lerp(q.t, o.t, a); }),
    cr: mix(A.cr, B.cr),
    pj: mix(A.pj, B.pj),
  };
}

// 自己的角色不等插值延遲：用最新一筆伺服器狀態，再依前兩筆算出的速度往前推到「現在」，
// 讓自己每一幀都在動（不會隨 30 次/秒的封包一格一格跳），最後做短暫平滑吸收預測誤差
const SELF_SMOOTH_MS = 25;
const SELF_MAX_AHEAD = 60; // 最多往前推幾毫秒，封包晚到時不要預測過頭
let selfPos = null;
function withSelfLatest(st, dt) {
  if (!st || !snaps.length) return st;
  const L = snaps[snaps.length - 1];
  const latest = L.s.p.find((p) => p.id === myId);
  if (!latest) { selfPos = null; return st; }
  const P = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const prev = P && P.s.p.find((p) => p.id === myId);
  const ahead = Math.min(SELF_MAX_AHEAD, performance.now() - L.at) / 1000;
  let tx = latest.x, ty = latest.y, tz = latest.z;
  if (prev && prev.s === latest.s && L.at > P.at && Math.hypot(prev.x - latest.x, prev.y - latest.y) < 150) {
    const span = (L.at - P.at) / 1000;
    tx += (latest.x - prev.x) / span * ahead;
    ty += (latest.y - prev.y) / span * ahead;
  }
  if (!selfPos || Math.hypot(selfPos.x - tx, selfPos.y - ty) > 150) { // 重生瞬移直接跳過去
    selfPos = { x: tx, y: ty, z: tz };
  } else {
    const k = 1 - Math.exp(-dt * 1000 / SELF_SMOOTH_MS);
    selfPos.x += (tx - selfPos.x) * k;
    selfPos.y += (ty - selfPos.y) * k;
    selfPos.z += (tz - selfPos.z) * k;
  }
  // 動作進度也往前推，攻擊動畫才不會一格一格
  const t = latest.du > 0 ? Math.min(latest.du, latest.t + ahead) : latest.t + ahead;
  const me = { ...latest, ...selfPos, t };
  return { ...st, p: st.p.some((p) => p.id === myId) ? st.p.map((p) => (p.id === myId ? me : p)) : [...st.p, me] };
}

/* ------------------------------------------------------------ 主迴圈 */

// 每一幀：畫 3D 場景，大廳開著時也更新預覽
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  R.render(withSelfLatest(viewState(), dt), myId, now, dt);
  if (!$('lobby').classList.contains('hidden')) preview.update(setup, now, dt);
  requestAnimationFrame(frame);
}

$('start').onclick = startGame;
$('addBot').onclick = (e) => { send({ t: 'bot', add: true }); e.currentTarget.blur(); };
$('delBot').onclick = (e) => { send({ t: 'bot', add: false }); e.currentTarget.blur(); };
$('openMenu').onclick = (e) => { showLobby(true); e.currentTarget.blur(); };
$('backBtn').onclick = () => showLobby(false);
$('helpBtn').onclick = () => $('helpDlg').showModal();
$('name').oninput = () => { setup.name = $('name').value; };
buildLobby();
R.ready.then(buildLobby); // manifest 讀完才知道有哪些角色
connect();
requestAnimationFrame(frame);
