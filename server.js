const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');
const Stripe = require('stripe');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const usedPaymentSessions = new Set();

const publicDir = path.join(__dirname, 'public');
const uploadDir = path.join(publicDir, 'uploads');
const coverDir = path.join(uploadDir, 'covers');
fs.mkdirSync(coverDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'cover' ? coverDir : uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'song') {
      return (file.mimetype === 'audio/mpeg' || file.originalname.toLowerCase().endsWith('.mp3'))
        ? cb(null, true) : cb(new Error('Only MP3 files are allowed for songs.'));
    }
    if (file.fieldname === 'cover') {
      return file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Cover art must be an image.'));
    }
    cb(new Error('Unexpected upload field.'));
  }
});

app.use(express.json());
app.use(express.static(publicDir));

const VFX = {
  fart: { label: 'FART', speech: null },
  boo: { label: 'BOOO', speech: 'BOOO!' },
  off: { label: 'TURN THIS OFF', speech: 'Turn this off!' },
  trash: { label: 'THIS IS TRASH', speech: 'This is trash!' }
};

const state = {
  contestants: [], current: null, playing: false, startedAt: null, pausedAt: 0,
  hostId: null, battle: { championId: null, challengerId: null }, voting: false,
  votingEndsAt: null, votes: {}, voterSockets: new Set(), round: 0, chat: []
};
const MAX_CONTESTANTS = 10, MAX_VIEWERS = 40, VOTE_SECONDS = 30;

function viewerCount() { return io.engine.clientsCount; }
function contestantById(id) { return state.contestants.find(c => c.id === id); }
function publicContestant(c) {
  return { id: c.id, name: c.name, social: c.social, song: c.song, url: c.url, coverUrl: c.coverUrl || null, order: c.order, status: c.status, wins: c.wins, losses: c.losses };
}
function voteTotals() {
  const ids = [state.battle.championId, state.battle.challengerId].filter(Boolean);
  const a = ids[0] ? (state.votes[ids[0]] || 0) : 0;
  const b = ids[1] ? (state.votes[ids[1]] || 0) : 0;
  const total = a + b;
  return { total, votes: state.votes, percentages: { [ids[0] || 'none']: total ? Math.round(a / total * 100) : 0, [ids[1] || 'none']: total ? Math.round(b / total * 100) : 0 } };
}
function publicState() {
  return {
    contestants: state.contestants.map(publicContestant), current: state.current, playing: state.playing,
    startedAt: state.startedAt, pausedAt: state.pausedAt, viewers: viewerCount(), maxViewers: MAX_VIEWERS,
    maxContestants: MAX_CONTESTANTS, battle: state.battle, voting: state.voting, votingEndsAt: state.votingEndsAt,
    voteData: voteTotals(), round: state.round, chat: state.chat.slice(-60),
    competitionComplete: state.contestants.length >= 2 && state.contestants.filter(c => c.status !== 'OUT').length === 1 && state.round >= state.contestants.length - 1
  };
}
function broadcast() { io.emit('state', publicState()); }
function setBattle(championId, challengerId) {
  state.battle = { championId, challengerId };
  state.current = championId;
  state.playing = false; state.startedAt = null; state.pausedAt = 0;
  state.voting = false; state.votingEndsAt = null; state.votes = {};
  if (championId) state.votes[championId] = 0;
  if (challengerId) state.votes[challengerId] = 0;
}

function finishVoting() {
  if (!state.voting) return;
  state.voting = false; state.votingEndsAt = null;
  const champion = contestantById(state.battle.championId);
  const challenger = contestantById(state.battle.challengerId);
  if (!champion || !challenger) { broadcast(); return; }
  const championVotes = state.votes[champion.id] || 0;
  const challengerVotes = state.votes[challenger.id] || 0;
  const winner = challengerVotes > championVotes ? challenger : champion;
  const loser = winner.id === champion.id ? challenger : champion;
  winner.wins += 1; loser.losses += 1; loser.status = 'OUT';

  io.emit('battle-finished', {
    round: state.round,
    winner: { id: winner.id, name: winner.name, song: winner.song, ownerUid: winner.ownerUid || null },
    loser: { id: loser.id, name: loser.name, song: loser.song, ownerUid: loser.ownerUid || null },
    winnerVotes: champion.id === winner.id ? championVotes : challengerVotes,
    loserVotes: champion.id === loser.id ? championVotes : challengerVotes,
    finishedAt: Date.now()
  });

  const next = state.contestants.find(c => c.status === 'WAITING' && c.id !== winner.id);
  if (next) { next.status = 'BATTLE'; state.round += 1; setBattle(winner.id, next.id); }
  else { winner.status = 'CHAMPION'; state.round = Math.max(state.round, state.contestants.length - 1); setBattle(winner.id, null); }
  state.voterSockets.clear();
  broadcast();
}

app.post('/api/upload', upload.fields([{ name: 'song', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  try {
    const songFile = req.files?.song?.[0], coverFile = req.files?.cover?.[0];
    if (!songFile) return res.status(400).json({ error: 'MP3 required.' });
    if (state.contestants.length >= MAX_CONTESTANTS) {
      fs.unlinkSync(songFile.path); if (coverFile) fs.unlinkSync(coverFile.path);
      return res.status(409).json({ error: 'The 10 contestant spots are full.' });
    }
    const name = String(req.body.name || 'Contestant').trim().slice(0, 30) || 'Contestant';
    const social = String(req.body.social || '').trim().slice(0, 40);
    const ownerUid = String(req.body.ownerUid || '').trim().slice(0, 128);
    const contestant = {
      id: Math.random().toString(36).slice(2, 10), name, social, song: songFile.originalname,
      ownerUid, url: `/uploads/${songFile.filename}`, coverUrl: coverFile ? `/uploads/covers/${coverFile.filename}` : null,
      order: state.contestants.length + 1, status: 'WAITING', wins: 0, losses: 0
    };
    state.contestants.push(contestant);
    if (state.contestants.length === 1) { contestant.status = 'CHAMPION'; setBattle(contestant.id, null); }
    else if (state.contestants.length === 2 && !state.battle.challengerId) {
      contestant.status = 'BATTLE'; const first = state.contestants[0]; first.status = 'BATTLE'; state.round = 1; setBattle(first.id, contestant.id);
    }
    broadcast(); res.json({ contestant: publicContestant(contestant) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/state', (req, res) => res.json(publicState()));

app.post('/api/create-vfx-checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'VFX payments are not configured yet.' });
    const effect = String(req.body.effect || '').trim();
    if (!VFX[effect]) return res.status(400).json({ error: 'Unknown VFX.' });
    const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'cashapp'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: `UG COMP ${VFX[effect].label} VFX` }, unit_amount: 100 }, quantity: 1 }],
      metadata: { vfx: effect },
      success_url: `${base}/?vfx_paid=${encodeURIComponent(effect)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?vfx_cancelled=1`
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message || 'Could not start checkout.' }); }
});

app.get('/api/verify-vfx-payment', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured.' });
    const effect = String(req.query.effect || '');
    const sessionId = String(req.query.session_id || '');
    if (!VFX[effect] || !sessionId) return res.status(400).json({ error: 'Missing payment information.' });
    if (usedPaymentSessions.has(sessionId)) return res.status(409).json({ error: 'This VFX purchase was already used.' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid' || session.metadata?.vfx !== effect) return res.status(402).json({ error: 'Payment is not confirmed.' });
    usedPaymentSessions.add(sessionId);
    res.json({ paid: true, effect });
  } catch (e) { res.status(500).json({ error: 'Could not verify payment.' }); }
});

io.on('connection', socket => {
  if (viewerCount() > MAX_VIEWERS) { socket.emit('capacity', { message: 'UG COMP is full right now. Try again later.' }); return socket.disconnect(true); }
  socket.emit('state', publicState());
  if (!state.hostId) { state.hostId = socket.id; socket.emit('host', true); }
  broadcast();

  socket.on('claim-host', () => { if (!state.hostId) { state.hostId = socket.id; socket.emit('host', true); } });
  socket.on('select', id => { if (socket.id !== state.hostId || !contestantById(id)) return; state.current = id; state.playing = false; state.startedAt = null; state.pausedAt = 0; broadcast(); });
  socket.on('play', () => { if (socket.id !== state.hostId || !state.current) return; state.playing = true; state.startedAt = Date.now() - (state.pausedAt * 1000); broadcast(); });
  socket.on('pause', elapsed => { if (socket.id !== state.hostId) return; state.pausedAt = Math.max(0, Number(elapsed) || 0); state.playing = false; state.startedAt = null; broadcast(); });
  socket.on('seek', elapsed => { if (socket.id !== state.hostId) return; state.pausedAt = Math.max(0, Number(elapsed) || 0); if (state.playing) state.startedAt = Date.now() - state.pausedAt * 1000; broadcast(); });
  socket.on('start-vote', () => { if (socket.id !== state.hostId || state.voting) return; if (!state.battle.championId || !state.battle.challengerId) return; state.voting = true; state.votingEndsAt = Date.now() + VOTE_SECONDS * 1000; state.votes = { [state.battle.championId]: 0, [state.battle.challengerId]: 0 }; state.voterSockets.clear(); broadcast(); setTimeout(() => finishVoting(), VOTE_SECONDS * 1000 + 100); });
  socket.on('end-vote', () => { if (socket.id === state.hostId) finishVoting(); });
  socket.on('vote', contestantId => { if (!state.voting || state.voterSockets.has(socket.id)) return; if (![state.battle.championId, state.battle.challengerId].includes(contestantId)) return; state.voterSockets.add(socket.id); state.votes[contestantId] = (state.votes[contestantId] || 0) + 1; broadcast(); });

  socket.on('remove-contestant', id => {
    if (socket.id !== state.hostId) return;
    const index = state.contestants.findIndex(c => c.id === id); if (index === -1) return;
    const removed = state.contestants[index];
    for (const url of [removed.url, removed.coverUrl]) { if (!url) continue; const fullPath = path.join(publicDir, url.replace(/^\//, '')); if (fs.existsSync(fullPath)) { try { fs.unlinkSync(fullPath); } catch (_) {} } }
    state.contestants.splice(index, 1);
    if (state.current === id) { state.current = null; state.playing = false; state.startedAt = null; state.pausedAt = 0; }
    state.voting = false; state.votingEndsAt = null; state.votes = {}; state.voterSockets.clear();
    state.battle = { championId: null, challengerId: null };
    for (const c of state.contestants) c.status = 'WAITING';
    if (state.contestants[0]) { state.contestants[0].status = 'CHAMPION'; state.battle.championId = state.contestants[0].id; }
    if (state.contestants[1]) { state.contestants[1].status = 'BATTLE'; state.battle.challengerId = state.contestants[1].id; state.round = 1; } else state.round = 0;
    setBattle(state.battle.championId, state.battle.challengerId); io.emit('contestant-removed', id); broadcast();
  });

  socket.on('vfx', effect => {
    const key = String(effect || '').trim();
    if (!VFX[key]) return;
    io.emit('vfx', { effect: key, label: VFX[key].label, at: Date.now() });
  });

  socket.on('chat', payload => {
    const text = typeof payload === 'string' ? payload : String(payload?.text || '');
    const clean = text.trim().slice(0, 180); if (!clean) return;
    const hidden = typeof payload === 'object' && !!payload.hidden;
    const identity = typeof payload === 'object' ? String(payload.identity || '') : '';
    const guest = hidden ? 'Anonymous' : (identity || `Guest ${socket.id.slice(-4)}`);
    state.chat.push({ id: Math.random().toString(36).slice(2, 10), text: clean, at: Date.now(), guest });
    if (state.chat.length > 100) state.chat.shift(); broadcast();
  });

  socket.on('disconnect', () => {
    state.voterSockets.delete(socket.id);
    if (socket.id === state.hostId) { state.hostId = null; for (const s of io.sockets.sockets.values()) { state.hostId = s.id; s.emit('host', true); break; } }
    broadcast();
  });
});

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Upload failed.' }));
server.listen(PORT, HOST, () => console.log(`UG COMP running at http://localhost:${PORT}`));
