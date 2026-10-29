// Gameplay: shared state in rooms/$id/gameState. Host runs the simulation (spawns, cooking, eating,
// patience, day end); both players send actions (seat / order / pickup / serve / collect) as transactions.
import { db, now } from './firebase.js';
import { ref, onValue, update, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const W = 800, H = 450, DAY_MS = 120000;
const TABLES = [[170,130],[340,130],[510,130],[170,290],[340,290],[510,290]].map(([x, y]) => ({ x, y }));
const COUNTER = { x: 640, y: 110, w: 130, h: 230 };
const qSlot = i => ({ x: 45 + i * 40, y: 410 });
const COLORS = ['#1b2a41', '#3b4b7a', '#5a3b7a', '#2f6b5a'];

let gs = null, gsRef, opts, unsub, timer, raf, hover = -1, canvas, ctx;
const pos = {};                                         // animated customer positions

export function startGame(o) {
  stopGame(); opts = o; gs = null;
  gsRef = ref(db, `rooms/${o.roomId}/gameState`);
  canvas = document.getElementById('canvas'); ctx = canvas.getContext('2d');
  unsub = onValue(gsRef, s => { gs = s.val(); syncShop(); });
  canvas.onpointerdown = e => click(toXY(e));
  canvas.onpointermove = e => { const p = toXY(e); hover = tableAt(p); };
  if (o.isHost) timer = setInterval(hostTick, 300);
  document.getElementById('btnNext').onclick = nextDay;
  raf = requestAnimationFrame(frame);
}
export function stopGame() {
  if (unsub) unsub(); clearInterval(timer); cancelAnimationFrame(raf);
  unsub = null; timer = null; gs = null;
  document.getElementById('shop')?.classList.add('d-none');
}

/* ---------- Helpers ---------- */
const toXY = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
const tableAt = p => TABLES.findIndex(t => Math.hypot(p.x - t.x, p.y - t.y) < 62);
const inCounter = p => p.x > COUNTER.x && p.x < COUNTER.x + COUNTER.w && p.y > COUNTER.y && p.y < COUNTER.y + COUNTER.h;
const custs = () => Object.entries(gs?.customers || {}).map(([id, c]) => ({ id, ...c }));
const cookTime = () => 6000 - 1000 * gs.upgrades.chef;
const patience = () => 20000 + 5000 * gs.upgrades.decor;
const cref = id => ref(db, `rooms/${opts.roomId}/gameState/customers/${id}`);

/* ---------- Player actions (either player) ---------- */
async function click(p) {
  if (!gs || gs.phase !== 'play') return;
  const list = custs();
  if (inCounter(p)) {                                   // pick up the oldest ready dish
    if (list.some(c => c.carrier === opts.uid)) return;
    const c = list.filter(c => c.state === 'ready').sort((a, b) => a.t - b.t)[0];
    if (c) runTransaction(cref(c.id), v => v && v.state === 'ready' ? { ...v, state: 'carried', carrier: opts.uid } : v);
    return;
  }
  const i = tableAt(p); if (i < 0) return;
  const c = list.find(c => c.table === i);
  if (!c) {                                             // empty table: seat the next waiting penguin
    const w = list.filter(c => c.state === 'waiting').sort((a, b) => a.arrive - b.arrive)[0];
    if (!w) return;
    const claim = await runTransaction(ref(db, `rooms/${opts.roomId}/gameState/tables/${i}`), v => v ? undefined : w.id);
    if (claim.committed) runTransaction(cref(w.id), v => v && v.state === 'waiting' ? { ...v, state: 'ordering', table: i, t: now() } : v);
  } else if (c.state === 'ordering') {
    runTransaction(cref(c.id), v => v && v.state === 'ordering' ? { ...v, state: 'cooking', t: now(), readyAt: now() + cookTime() } : v);
  } else if (c.state === 'carried' && c.carrier === opts.uid) {
    const fast = Math.max(0, 12 - Math.floor((now() - c.arrive) / 3000));
    const tip = Math.round((8 + fast) * (1 + 0.15 * gs.upgrades.skates));
    runTransaction(cref(c.id), v => v && v.state === 'carried' ? { ...v, state: 'eating', t: now(), eatEnd: now() + 4000, tip, carrier: null } : v);
  } else if (c.state === 'paid') {                      // clear tips + table
    const done = await runTransaction(cref(c.id), v => v && v.state === 'paid' ? null : v);
    if (done.committed) {
      update(gsRef, { [`tables/${i}`]: null });
      runTransaction(gsRef, g => { if (g) { g.money += c.tip; g.dayEarned += c.tip; } return g; });
    }
  }
}

/* ---------- Host simulation ---------- */
function hostTick() {
  if (!gs || gs.phase !== 'play') return;
  const t = now(), up = {}, P = patience();
  let waiting = 0;
  for (const c of custs()) {
    const gone = () => { up[`customers/${c.id}`] = null; if (c.table != null) up[`tables/${c.table}`] = null; };
    if (c.state === 'waiting') { waiting++; if (t - c.arrive > P) gone(); }
    else if (['ordering', 'cooking', 'ready', 'carried'].includes(c.state) && t - c.seatedAt > P * 3) gone();
    else if (c.state === 'ordering' && !c.seatedAt) up[`customers/${c.id}/seatedAt`] = t;
    else if (c.state === 'cooking' && t >= c.readyAt) { up[`customers/${c.id}/state`] = 'ready'; up[`customers/${c.id}/t`] = t; }
    else if (c.state === 'eating' && t >= c.eatEnd) up[`customers/${c.id}/state`] = 'paid';
  }
  if (t >= gs.nextSpawn && waiting < 4) {
    const id = 'c' + t.toString(36) + Math.random().toString(36).slice(2, 4);
    up[`customers/${id}`] = { state: 'waiting', arrive: t, t, color: Math.random() * COLORS.length | 0 };
    up.nextSpawn = t + Math.max(2500, 6000 - gs.day * 400) + Math.random() * 2000;
  }
  if (t >= gs.startAt + DAY_MS) up.phase = gs.dayEarned >= gs.target ? 'shop' : 'fail';
  if (Object.keys(up).length) update(gsRef, up);
}
function nextDay() {
  if (!opts.isHost || !gs) return;
  const day = gs.phase === 'shop' ? gs.day + 1 : gs.day;   // retry the same day after a fail
  update(gsRef, { phase: 'play', day, startAt: now(), dayEarned: 0, target: 60 + (day - 1) * 45, nextSpawn: now() + 1500, customers: null, tables: null });
}

/* ---------- Upgrade shop (both players can buy) ---------- */
const ITEMS = { skates: ['Roller skates', '+15% tips per level'], chef: ['Better chef', 'Cooks 1s faster'], decor: ['Decorations', 'Customers wait 5s longer'] };
function syncShop() {
  const shop = document.getElementById('shop');
  const open = gs && (gs.phase === 'shop' || gs.phase === 'fail');
  shop.classList.toggle('d-none', !open); if (!open) return;
  const ok = gs.phase === 'shop';
  document.getElementById('shopTitle').textContent = ok ? `Day ${gs.day} cleared!` : `Missed the $${gs.target} target`;
  document.getElementById('shopInfo').textContent = ok ? `Wallet: $${gs.money}. Spend it on upgrades.` : `You earned $${gs.dayEarned}. Retry the day.`;
  const box = document.getElementById('shopItems'); box.innerHTML = '';
  if (ok) for (const k in ITEMS) {
    const lvl = gs.upgrades[k], cost = 60 * (lvl + 1), b = document.createElement('button');
    b.className = 'btn btn-outline-info'; b.disabled = lvl >= 3 || gs.money < cost;
    b.textContent = `${ITEMS[k][0]} Lv${lvl} (${ITEMS[k][1]}) ${lvl >= 3 ? 'MAX' : '$' + cost}`;
    b.onclick = () => runTransaction(gsRef, g => { if (g && g.money >= cost && g.upgrades[k] === lvl) { g.money -= cost; g.upgrades[k]++; } return g; });
    box.appendChild(b);
  }
  const nb = document.getElementById('btnNext'); nb.disabled = !opts.isHost;
  nb.textContent = opts.isHost ? (ok ? 'Start next day' : 'Retry day') : 'Waiting for host…';
}

/* ---------- Rendering ---------- */
function frame(ts) {
  raf = requestAnimationFrame(frame);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#d7f1fb'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#b3e0f2'; for (let x = 0; x < W; x += 80) for (let y = 0; y < H; y += 80) if ((x + y) / 80 % 2) ctx.fillRect(x, y, 80, 80);
  drawCounter(); TABLES.forEach((t, i) => drawTable(t, i === hover));
  if (!gs) return;
  const list = custs(), waiting = list.filter(c => c.state === 'waiting').sort((a, b) => a.arrive - b.arrive);
  for (const c of list) {
    const target = c.state === 'waiting' ? qSlot(waiting.indexOf(c)) : { x: TABLES[c.table]?.x ?? 0, y: (TABLES[c.table]?.y ?? 0) - 38 };
    const p = pos[c.id] ||= { x: -30, y: 410 };
    p.x += (target.x - p.x) * 0.12; p.y += (target.y - p.y) * 0.12;
    drawPenguin(p.x, p.y + Math.sin(ts / 200 + p.x) * 2, COLORS[c.color || 0], c.state === 'ordering');
    if (c.state === 'eating') drawFish(p.x, p.y + 52, 0.7);
    if (c.state === 'paid') drawCoin(TABLES[c.table].x + 30, TABLES[c.table].y + 5);
    if (['cooking', 'ready', 'carried'].includes(c.state)) bubble(p.x + 24, p.y - 30, '🐟');
    if (c.state === 'ordering') bubble(p.x + 24, p.y - 30, '!');
  }
  list.filter(c => c.state === 'ready').slice(0, 4).forEach((c, i) => drawFish(COUNTER.x + 40 + (i % 2) * 50, COUNTER.y + 60 + (i >> 1) * 60, 1));
  for (const id in pos) if (!gs.customers?.[id]) delete pos[id];
  // HUD
  const left = Math.max(0, Math.ceil((gs.startAt + DAY_MS - now()) / 1000));
  const carrying = list.some(c => c.carrier === opts.uid) ? ' | 🐟 carrying' : '';
  document.getElementById('hud').innerHTML = `<span>Day ${gs.day}</span><span>⏱ ${left}s</span><span>Today $${gs.dayEarned}/$${gs.target}</span><span>Wallet $${gs.money}${carrying}</span>`;
}
function drawTable(t, hot) {
  ctx.fillStyle = hot ? '#e0a96d' : '#c68642'; ctx.strokeStyle = '#7a4a1d'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.ellipse(t.x, t.y + 10, 58, 34, 0, 0, 7); ctx.fill(); ctx.stroke();
}
function drawCounter() {
  ctx.fillStyle = '#8fa3b5'; ctx.strokeStyle = '#4b5d6e'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.roundRect(COUNTER.x, COUNTER.y, COUNTER.w, COUNTER.h, 14); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#243447'; ctx.font = 'bold 16px sans-serif'; ctx.fillText('Kitchen', COUNTER.x + 30, COUNTER.y + 24);
}
function drawPenguin(x, y, col, hand) {
  ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, 24, 32, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(x, y + 8, 15, 21, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(x - 8, y - 14, 6, 0, 7); ctx.arc(x + 8, y - 14, 6, 0, 7); ctx.fill();
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(x - 7, y - 14, 2.5, 0, 7); ctx.arc(x + 9, y - 14, 2.5, 0, 7); ctx.fill();
  ctx.fillStyle = '#ff9f1c'; ctx.beginPath(); ctx.moveTo(x - 6, y - 7); ctx.lineTo(x + 6, y - 7); ctx.lineTo(x, y + 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x - 10, y + 32, 9, 4, 0, 0, 7); ctx.ellipse(x + 10, y + 32, 9, 4, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath();
  ctx.moveTo(x + 22, y); ctx.lineTo(x + 30, hand ? y - 28 : y + 14); ctx.stroke();
}
function drawFish(x, y, s) {
  ctx.fillStyle = '#ff7b54'; ctx.beginPath(); ctx.ellipse(x, y, 16 * s, 9 * s, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + 14 * s, y); ctx.lineTo(x + 26 * s, y - 9 * s); ctx.lineTo(x + 26 * s, y + 9 * s); ctx.fill();
}
function drawCoin(x, y) {
  ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#b88a00'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 13, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#7a5a00'; ctx.font = 'bold 15px sans-serif'; ctx.fillText('$', x - 5, y + 5);
}
function bubble(x, y, txt) {
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.fill();
  ctx.fillStyle = '#c1121f'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(txt, x, y + 6); ctx.textAlign = 'left';
}
