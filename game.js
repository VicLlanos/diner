// Gameplay for 1-3 players. Shared state: rooms/$id/gameState. The host's browser simulates timers
// (spawns, cooking, eating, patience, day end); every player sends actions as transactions.
import { db, now } from './firebase.js';
import { ref, onValue, update, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const W = 800, H = 450, DAY_MS = 120000;
const TABLES = [[170,140],[340,140],[510,140],[170,300],[340,300],[510,300]].map(([x, y]) => ({ x, y }));
const COUNTER = { x: 640, y: 96, w: 130, h: 230 };
const qSlot = i => ({ x: 50 + i * 42, y: 405 });
const SCARF = ['#d62839', '#2a9d8f', '#f4a261', '#7b2cbf', '#4cc9f0'];
const HAT = ['#ff9f1c', '#2ec4b6', '#e76f8b'];            // one colour per player

let gs = null, players = {}, gsRef, opts, unsubs = [], timer, raf, hover = -1, canvas, ctx, bg;
const pos = {};

export function startGame(o) {
  stopGame(); opts = o; gs = null;
  const base = `rooms/${o.roomId}`;
  gsRef = ref(db, `${base}/gameState`);
  canvas = document.getElementById('canvas'); ctx = canvas.getContext('2d'); bg = makeBG();
  unsubs = [onValue(gsRef, s => { gs = s.val(); syncShop(); }), onValue(ref(db, `${base}/players`), s => { players = s.val() || {}; })];
  canvas.onpointerdown = e => click(toXY(e));
  canvas.onpointermove = e => { hover = tableAt(toXY(e)); };
  if (o.isHost) timer = setInterval(hostTick, 300);
  document.getElementById('btnNext').onclick = nextDay;
  raf = requestAnimationFrame(frame);
}
export function stopGame() {
  unsubs.forEach(u => u()); unsubs = []; clearInterval(timer); cancelAnimationFrame(raf);
  timer = null; gs = null; players = {};
  document.getElementById('shop')?.classList.add('d-none');
}

/* ---------- Helpers ---------- */
const toXY = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
const tableAt = p => TABLES.findIndex(t => Math.hypot(p.x - t.x, p.y - t.y) < 62);
const inCounter = p => p.x > COUNTER.x && p.x < COUNTER.x + COUNTER.w && p.y > COUNTER.y && p.y < COUNTER.y + COUNTER.h;
const custs = () => Object.entries(gs?.customers || {}).map(([id, c]) => ({ id, ...c }));
const cookTime = () => 6000 - 1000 * gs.upgrades.chef;
const patience = () => 20000 + 5000 * gs.upgrades.decor;
const nPlayers = () => Math.max(1, Object.keys(players).length);
const cref = id => ref(db, `rooms/${opts.roomId}/gameState/customers/${id}`);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const order = () => Object.keys(players).sort();       // stable player order -> stable colours

/* ---------- Player actions ---------- */
async function click(p) {
  if (!gs || gs.phase !== 'play') return;
  const list = custs();
  if (inCounter(p)) {                                   // pick up the oldest ready dish (one at a time)
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
  } else if (c.state === 'paid') {                      // clear tip + table
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
  const t = now(), up = {}, P = patience(), n = nPlayers();
  let waiting = 0;
  for (const c of custs()) {
    const gone = () => { up[`customers/${c.id}`] = null; if (c.table != null) up[`tables/${c.table}`] = null; };
    if (c.state === 'waiting') { waiting++; if (t - c.arrive > P) gone(); }
    else if (['ordering', 'cooking', 'ready', 'carried'].includes(c.state) && t - c.seatedAt > P * 3) gone();
    else if (c.state === 'ordering' && !c.seatedAt) up[`customers/${c.id}/seatedAt`] = t;
    else if (c.state === 'cooking' && t >= c.readyAt) { up[`customers/${c.id}/state`] = 'ready'; up[`customers/${c.id}/t`] = t; }
    else if (c.state === 'eating' && t >= c.eatEnd) up[`customers/${c.id}/state`] = 'paid';
    // A player who left while carrying a dish: put it back on the counter.
    if (c.state === 'carried' && !players[c.carrier]) { up[`customers/${c.id}/state`] = 'ready'; up[`customers/${c.id}/carrier`] = null; }
  }
  if (t >= gs.nextSpawn && waiting < 3 + n) {
    const id = 'c' + t.toString(36) + Math.random().toString(36).slice(2, 4);
    up[`customers/${id}`] = { state: 'waiting', arrive: t, t, color: Math.random() * SCARF.length | 0 };
    up.nextSpawn = t + (Math.max(2500, 6000 - gs.day * 400) + Math.random() * 2000) / (1 + 0.45 * (n - 1));  // more players -> busier diner
  }
  if (t >= gs.startAt + DAY_MS) up.phase = gs.dayEarned >= gs.target ? 'shop' : 'fail';
  if (Object.keys(up).length) update(gsRef, up);
}
function nextDay() {
  if (!opts.isHost || !gs) return;
  const day = gs.phase === 'shop' ? gs.day + 1 : gs.day;   // retry the same day after a miss
  const target = Math.round((60 + (day - 1) * 45) * (1 + 0.5 * (nPlayers() - 1)));
  update(gsRef, { phase: 'play', day, startAt: now(), dayEarned: 0, target, nextSpawn: now() + 1500, customers: null, tables: null });
}

/* ---------- Upgrade shop ---------- */
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
const lin = (g, y0, y1, stops) => { const l = g.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, c]) => l.addColorStop(o, c)); return l; };

// Static room (wall, windows, wooden floor, door mat) drawn once to an offscreen canvas.
function makeBG() {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = lin(g, 0, 72, [[0, '#f8ecd8'], [1, '#e0c59a']]); g.fillRect(0, 0, W, 72);
  for (let i = 0; i < 3; i++) {                                         // windows with sky + frosty hills
    const x = 90 + i * 230;
    g.fillStyle = lin(g, 10, 56, [[0, '#7ec8e8'], [1, '#d9f2fb']]); g.fillRect(x, 10, 110, 46);
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x, 56); g.lineTo(x + 30, 34); g.lineTo(x + 58, 56); g.lineTo(x + 80, 40); g.lineTo(x + 110, 56); g.fill();
    g.strokeStyle = '#fffaf0'; g.lineWidth = 6; g.strokeRect(x, 10, 110, 46); g.lineWidth = 3; g.beginPath(); g.moveTo(x + 55, 10); g.lineTo(x + 55, 56); g.stroke();
  }
  g.fillStyle = lin(g, 72, H, [[0, '#cf9a60'], [1, '#a46d3a']]); g.fillRect(0, 72, W, H - 72);
  g.strokeStyle = 'rgba(70,38,12,.28)'; g.lineWidth = 1.5;                 // plank seams
  for (let y = 72, r = 0; y < H; y += 30, r++) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    for (let x = (r % 2) * 70; x < W; x += 140) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 30); g.stroke(); }
  }
  g.fillStyle = 'rgba(255,255,255,.07)'; for (let i = 0; i < 90; i++) g.fillRect(Math.random() * W, 72 + Math.random() * (H - 72), 30 + Math.random() * 40, 1.5); // grain
  g.fillStyle = lin(g, 72, 92, [[0, 'rgba(0,0,0,.28)'], [1, 'rgba(0,0,0,0)']]); g.fillRect(0, 72, W, 20);   // wall shadow
  g.fillStyle = '#5b3a29'; g.beginPath(); g.roundRect(14, 395, 130, 44, 8); g.fill();                         // door mat
  g.fillStyle = '#8a5a3c'; g.beginPath(); g.roundRect(20, 400, 118, 34, 6); g.fill();
  return c;
}

function frame(ts) {
  raf = requestAnimationFrame(frame);
  ctx.drawImage(bg, 0, 0);
  const t = now(), list = gs ? custs() : [], P = gs ? patience() : 1;
  const waiting = list.filter(c => c.state === 'waiting').sort((a, b) => a.arrive - b.arrive);
  drawCounter(ts, list.some(c => c.state === 'cooking'));
  for (const c of list) {                                               // ease penguins toward their spot
    const tb = TABLES[c.table], target = c.state === 'waiting' ? qSlot(waiting.indexOf(c)) : { x: tb.x, y: tb.y - 34 };
    const p = pos[c.id] ||= { x: -30, y: 405 };
    p.x += (target.x - p.x) * 0.1; p.y += (target.y - p.y) * 0.1;
    p.moving = Math.hypot(target.x - p.x, target.y - p.y) > 3;
    drawPenguin(p.x, p.y, { scarf: SCARF[(c.color || 0) % SCARF.length], hand: c.state === 'ordering', t: ts, walk: p.moving });
  }
  TABLES.forEach((tb, i) => drawTable(tb, i === hover));
  for (const c of list) {                                               // things on top: food, coins, bubbles, patience
    const p = pos[c.id], tb = TABLES[c.table];
    if (c.state === 'eating') drawFish(tb.x, tb.y + 12, 0.8);
    if (c.state === 'paid') drawCoins(tb.x + 34, tb.y + 14, ts);
    if (c.state === 'ordering') bubble(p.x + 30, p.y - 44, '!', '#d62839');
    if (['cooking', 'ready', 'carried'].includes(c.state)) bubble(p.x + 30, p.y - 44, '🐟', '#1b2a41');
    const lim = c.state === 'waiting' ? P : ['ordering', 'cooking', 'ready', 'carried'].includes(c.state) ? P * 3 : 0;
    if (lim) meter(p.x, p.y - 44, 1 - (t - (c.state === 'waiting' ? c.arrive : c.seatedAt || c.t)) / lim);
  }
  list.filter(c => c.state === 'ready').sort((a, b) => a.t - b.t).slice(0, 4).forEach((c, i) => drawFish(COUNTER.x + 40 + (i % 2) * 52, COUNTER.y + 118 + (i >> 1) * 52, 1));
  order().forEach((uid, i) => {                                         // waiters on skates near the counter
    const carrying = list.some(c => c.carrier === uid);
    drawPenguin(COUNTER.x + 22 + i * 46, 385, { scarf: HAT[i], t: ts, waiter: true, skates: true, tray: carrying, me: uid === opts.uid });
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText((players[uid].name || '').slice(0, 8), COUNTER.x + 22 + i * 46, 440); ctx.textAlign = 'left';
  });
  const v = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 520);   // soft lighting vignette
  v.addColorStop(0, 'rgba(255,240,200,0)'); v.addColorStop(1, 'rgba(20,10,0,.38)'); ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  if (!gs) return;
  const left = Math.max(0, Math.ceil((gs.startAt + DAY_MS - t) / 1000));
  document.getElementById('hud').innerHTML = `<span class="pill">Day ${gs.day}</span><span class="pill">⏱ ${left}s</span>
    <span class="pill">Today $${gs.dayEarned} / $${gs.target}</span><span class="pill">Wallet $${gs.money}</span>
    ${order().map((u, i) => `<span class="pill"><span class="dot" style="background:${HAT[i]}"></span>${esc(players[u].name || '')}</span>`).join('')}`;
}

function drawTable(t, hot) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(t.x + 8, t.y + 34, 62, 24, 0, 0, 7); ctx.fill();
  const g = ctx.createRadialGradient(t.x - 20, t.y - 2, 6, t.x, t.y + 12, 66); g.addColorStop(0, '#ebbf88'); g.addColorStop(1, '#a5662d');
  ctx.fillStyle = g; ctx.strokeStyle = hot ? '#fff' : '#6b3f17'; ctx.lineWidth = hot ? 5 : 3;
  ctx.beginPath(); ctx.ellipse(t.x, t.y + 12, 58, 32, 0, 0, 7); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(t.x, t.y + 10, 52, 27, 0, 3.4, 5.8); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c9d3da'; ctx.lineWidth = 2;               // plate
  ctx.beginPath(); ctx.ellipse(t.x, t.y + 18, 24, 12, 0, 0, 7); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(t.x, t.y + 18, 15, 7, 0, 0, 7); ctx.stroke();
  ctx.restore();
}
function drawCounter(ts, cooking) {
  const { x, y, w, h } = COUNTER;
  drawPenguin(x + w / 2, y + 36, { scarf: '#fff', t: ts, chef: true, hand: false, walk: cooking });   // chef behind the pass
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.roundRect(x + 6, y + 10, w, h, 14); ctx.fill();
  ctx.fillStyle = lin(ctx, y + 60, y + h, [[0, '#b9c7d3'], [0.15, '#e8eff4'], [1, '#7f93a4']]);
  ctx.strokeStyle = '#4b5d6e'; ctx.lineWidth = 4; ctx.beginPath(); ctx.roundRect(x, y + 60, w, h - 60, 12); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,170,60,.35)'; for (const cx of [x + 35, x + 95]) { ctx.beginPath(); ctx.ellipse(cx, y + 80, 22, 8, 0, 0, 7); ctx.fill(); }   // heat-lamp glow
  if (cooking) for (let i = 0; i < 4; i++) { const k = ((ts / 900) + i / 4) % 1; ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - k)})`; ctx.beginPath(); ctx.arc(x + 40 + i * 16, y + 52 - k * 30, 5 + k * 6, 0, 7); ctx.fill(); }
}

// Penguin: shaded body, belly, blinking eyes, waddling sway, flippers; options add scarf, hat, skates, tray.
function drawPenguin(x, y, o) {
  const sway = o.walk ? Math.sin(o.t / 110) * 0.09 : Math.sin(o.t / 600 + x) * 0.02;
  const blink = (o.t + x * 37) % 3200 < 120;
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.ellipse(0, 38, 24, 7, 0, 0, 7); ctx.fill();
  ctx.rotate(sway);
  const fl = (s, ang) => { ctx.save(); ctx.translate(s * 22, -4); ctx.rotate(ang); ctx.fillStyle = '#17233a'; ctx.beginPath(); ctx.ellipse(0, 14, 6, 17, 0, 0, 7); ctx.fill(); ctx.restore(); };
  fl(-1, 0.35 + (o.walk ? Math.sin(o.t / 110) * .25 : 0));
  fl(1, o.hand ? 2.7 + Math.sin(o.t / 160) * 0.35 : -0.35);                        // raised flipper = "ready to order"
  let g = ctx.createRadialGradient(-9, -16, 4, 0, 2, 38); g.addColorStop(0, '#46587a'); g.addColorStop(1, '#0f1829');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 4, 25, 34, 0, 0, 7); ctx.fill();
  g = ctx.createRadialGradient(-4, 4, 3, 0, 12, 26); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#cfdbe6');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 12, 16, 23, 0, 0, 7); ctx.fill();
  if (o.scarf) { ctx.strokeStyle = o.scarf; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.beginPath(); ctx.ellipse(0, -9, 15, 5, 0, 0.1, Math.PI - 0.1); ctx.stroke(); }
  for (const s of [-1, 1]) {                                                         // eyes
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(s * 8, -17, 6.5, blink ? 1 : 7, 0, 0, 7); ctx.fill();
    if (!blink) { ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(s * 8 + 1, -16, 3, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillRect(s * 8 + 1, -18, 1.5, 1.5); }
  }
  g = ctx.createLinearGradient(0, -12, 0, 0); g.addColorStop(0, '#ffb74a'); g.addColorStop(1, '#e8760a');
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-7, -11); ctx.quadraticCurveTo(0, -14, 7, -11); ctx.lineTo(0, -1); ctx.fill();
  ctx.fillStyle = '#f08a1c'; ctx.beginPath(); ctx.ellipse(-10, 38, 10, 4.5, 0, 0, 7); ctx.ellipse(10, 38, 10, 4.5, 0, 0, 7); ctx.fill();
  if (o.skates) { ctx.fillStyle = '#333'; for (const s of [-1, 1]) for (const k of [-5, 5]) { ctx.beginPath(); ctx.arc(s * 10 + k, 44, 3, 0, 7); ctx.fill(); } }
  if (o.waiter) { ctx.fillStyle = o.scarf; ctx.beginPath(); ctx.ellipse(0, -31, 14, 5, 0, 0, 7); ctx.fill(); ctx.fillRect(-9, -40, 18, 10); }
  if (o.chef) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-8, -36, 8, 0, 7); ctx.arc(8, -36, 8, 0, 7); ctx.arc(0, -42, 9, 0, 7); ctx.fill(); ctx.fillRect(-10, -36, 20, 8); }
  if (o.me) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.ellipse(0, 40, 30, 9, 0, 0, 7); ctx.stroke(); }
  ctx.restore();
  if (o.tray) drawFish(x + 20, y - 8, 0.7);
}
function drawFish(x, y, s) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  const g = ctx.createLinearGradient(0, -10, 0, 10); g.addColorStop(0, '#ffa07a'); g.addColorStop(0.55, '#ff6b4a'); g.addColorStop(1, '#f7c6a8');
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 0, 17, 9, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#e24a2b'; ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(27, -10); ctx.lineTo(24, 0); ctx.lineTo(27, 10); ctx.fill();   // tail
  ctx.beginPath(); ctx.moveTo(-3, -8); ctx.lineTo(3, -15); ctx.lineTo(8, -8); ctx.fill();                                                    // fin
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; for (let i = -6; i < 8; i += 5) { ctx.beginPath(); ctx.arc(i, 0, 4, -1, 1); ctx.stroke(); }
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-10, -2, 2.5, 0, 7); ctx.fill(); ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(-10, -2, 1.2, 0, 7); ctx.fill();
  ctx.restore();
}
function drawCoins(x, y, ts) {
  const b = Math.sin(ts / 300) * 2;
  for (let i = 0; i < 3; i++) {
    const cy = y - i * 4 + b; ctx.fillStyle = '#b88a00'; ctx.beginPath(); ctx.ellipse(x, cy + 3, 13, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.ellipse(x, cy, 13, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.ellipse(x - 4, cy - 1.5, 4, 1.5, 0, 0, 7); ctx.fill();
  }
}
function bubble(x, y, txt, col) {
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.roundRect(x - 15, y - 14, 30, 26, 10); ctx.moveTo(x - 8, y + 11); ctx.lineTo(x - 14, y + 20); ctx.lineTo(x, y + 11); ctx.fill(); ctx.restore();
  ctx.fillStyle = col; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(txt, x, y + 6); ctx.textAlign = 'left';
}
function meter(x, y, f) {
  f = Math.max(0, Math.min(1, f));
  ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.roundRect(x - 20, y - 2, 40, 6, 3); ctx.fill();
  ctx.fillStyle = `hsl(${f * 120},75%,48%)`; ctx.beginPath(); ctx.roundRect(x - 20, y - 2, 40 * f, 6, 3); ctx.fill();
}
