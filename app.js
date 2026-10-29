// Auth + lobby + room flow. Gameplay lives in game.js.
import { auth, db, now } from './firebase.js';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, updateProfile }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { ref, set, get, onValue, update, remove, runTransaction, onDisconnect }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { startGame, stopGame } from './game.js';

const $ = id => document.getElementById(id);
const show = n => ['lobby', 'room', 'game'].forEach(s => $(s).classList.toggle('d-none', s !== n));
const authModal = new bootstrap.Modal($('authModal'));
let user = null, mySlot = null, code = null, isHost = false, inGame = false, unsubRoom = null;

/* ---------- Auth ---------- */
onAuthStateChanged(auth, u => {
  user = u;
  $('btnOut').classList.toggle('d-none', !u);
  $('who').textContent = u ? (u.displayName || u.email) : '';
  if (u) { authModal.hide(); show('lobby'); } else { leaveRoom(false); ['lobby','room','game'].forEach(s => $(s).classList.add('d-none')); authModal.show(); }
});
const authErr = e => $('authMsg').textContent = e.code ? e.code.replace('auth/', '').replace(/-/g, ' ') : e.message;
$('btnSignIn').onclick = () => signInWithEmailAndPassword(auth, $('authEmail').value, $('authPass').value).catch(authErr);
$('btnSignUp').onclick = async () => {
  const name = $('authName').value.trim();
  if (!name) return ($('authMsg').textContent = 'Pick a username first.');
  try {
    const c = await createUserWithEmailAndPassword(auth, $('authEmail').value, $('authPass').value);
    await updateProfile(c.user, { displayName: name });
    await set(ref(db, `users/${c.user.uid}`), { name });
    $('who').textContent = name; user = auth.currentUser;
  } catch (e) { authErr(e); }
};
$('btnOut').onclick = () => signOut(auth);

/* ---------- Lobby ---------- */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rand4 = () => Array.from({ length: 4 }, () => ALPHA[Math.random() * ALPHA.length | 0]).join('');
const me = () => ({ name: user.displayName || user.email, ready: false });
const say = m => $('lobbyMsg').textContent = m;
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

$('btnHost').onclick = async () => {
  for (let i = 0; i < 5; i++) {               // retry on the rare code collision
    const c = rand4();
    const res = await runTransaction(ref(db, `rooms/${c}`), cur =>
      cur === null ? { hostUid: user.uid, status: 'lobby', players: { [user.uid]: me() } } : undefined);
    if (res.committed) return enterRoom(c, true);
  }
  say('Could not create a room. Try again.');
};
$('btnJoin').onclick = async () => {
  const c = $('joinCode').value.trim().toUpperCase();
  const r = (await get(ref(db, `rooms/${c}`))).val();
  if (!r || r.status !== 'lobby') return say('No open room with that code.');
  const free = ['1', '2'].filter(k => !(r.slots && r.slots[k]));
  if (!free.length) return say('That room is full (3 players max).');
  for (const k of free) {                      // two guests racing for a slot: loser tries the next one
    try {
      await update(ref(db, `rooms/${c}`), { [`players/${user.uid}`]: me(), [`slots/${k}`]: user.uid });
      mySlot = k; return enterRoom(c, false);
    } catch {}
  }
  say('Could not join that room.');
};

/* ---------- Room ---------- */
function enterRoom(c, host) {
  code = c; isHost = host; inGame = false;
  $('roomCode').textContent = c; say(''); show('room');
  // Disconnect handling: host closes the room, a guest frees their seat.
  if (host) onDisconnect(ref(db, `rooms/${c}/status`)).set('closed');
  else onDisconnect(ref(db, `rooms/${c}`)).update({ [`players/${user.uid}`]: null, [`slots/${mySlot}`]: null });

  unsubRoom = onValue(ref(db, `rooms/${c}`), snap => {
    const r = snap.val();
    if (!r || r.status === 'closed') return leaveRoom(true, 'The host left. Room closed.');
    if (r.status === 'playing') {
      if (!inGame) { inGame = true; show('game'); startGame({ roomId: c, uid: user.uid, isHost, onExit: () => leaveRoom(true) }); }
      return;
    }
    const ids = [r.hostUid, ...Object.keys(r.players || {}).filter(i => i !== r.hostUid)];
    $('players').innerHTML = [0, 1, 2].map(i => ids[i]
      ? `<li class="list-group-item bg-transparent text-light d-flex justify-content-between"><span>${i ? '🐧' : '👑'} ${esc(r.players[ids[i]].name)}</span><span>${i ? (r.players[ids[i]].ready ? '✅ Ready' : 'Not ready') : 'Host'}</span></li>`
      : `<li class="list-group-item bg-transparent text-secondary">Open seat</li>`).join('');
    const guestsReady = ids.slice(1).every(i => r.players[i].ready);
    $('btnStart').classList.toggle('d-none', !isHost);
    $('btnReady').classList.toggle('d-none', isHost);
    $('btnStart').disabled = !guestsReady;
    $('btnStart').textContent = ids.length === 1 ? 'Play solo' : 'Start game';
  });
}
$('btnStart').onclick = async () => {
  const n = Object.keys((await get(ref(db, `rooms/${code}/players`))).val() || {}).length, t = now();
  update(ref(db, `rooms/${code}`), { status: 'playing', gameState: {
    phase: 'play', day: 1, startAt: t, target: Math.round(60 * (1 + 0.5 * (n - 1))), money: 0, dayEarned: 0,
    nextSpawn: t + 1500, upgrades: { skates: 0, chef: 0, decor: 0 } } });
};
$('btnReady').onclick = async () => {
  const s = await get(ref(db, `rooms/${code}/players/${user.uid}/ready`));
  update(ref(db, `rooms/${code}/players/${user.uid}`), { ready: !s.val() });
};
$('btnLeave').onclick = () => leaveRoom(true);

function leaveRoom(cleanup = true, msg) {
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }
  stopGame();
  if (code && user && cleanup) {
    onDisconnect(ref(db, `rooms/${code}`)).cancel();
    onDisconnect(ref(db, `rooms/${code}/status`)).cancel();
    (isHost ? remove(ref(db, `rooms/${code}`))
            : update(ref(db, `rooms/${code}`), { [`players/${user.uid}`]: null, [`slots/${mySlot}`]: null })).catch(() => {});
  }
  code = null; mySlot = null; inGame = false;
  if (user) show('lobby');
  if (msg) say(msg);
}
