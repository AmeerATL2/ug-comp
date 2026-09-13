const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const publicDir = path.join(__dirname, 'public');
const uploadDir = path.join(publicDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'audio/mpeg' || file.originalname.toLowerCase().endsWith('.mp3')) cb(null, true);
    else cb(new Error('Only MP3 files are allowed.'));
  }
});

app.use(express.json());
app.use(express.static(publicDir));

const state = {
  contestants: [],
  current: null,
  playing: false,
  startedAt: null,
  pausedAt: 0,
  hostId: null
};

function viewerCount() {
  return io.engine.clientsCount;
}
function publicState() {
  return {
    contestants: state.contestants,
    current: state.current,
    playing: state.playing,
    startedAt: state.startedAt,
    pausedAt: state.pausedAt,
    viewers: viewerCount(),
    maxViewers: 35,
    maxContestants: 10
  };
}
function broadcast() { io.emit('state', publicState()); }

app.post('/api/upload', upload.single('song'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'MP3 required.' });
    if (state.contestants.length >= 10) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({ error: 'The 10 contestant spots are full.' });
    }
    const name = String(req.body.name || 'Contestant').trim().slice(0, 30) || 'Contestant';
    const contestant = {
      id: Math.random().toString(36).slice(2, 10),
      name,
      song: req.file.originalname,
      url: `/uploads/${req.file.filename}`
    };
    state.contestants.push(contestant);
    if (!state.current) state.current = contestant.id;
    broadcast();
    res.json({ contestant });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/state', (req, res) => res.json(publicState()));

io.on('connection', socket => {
  socket.emit('state', publicState());
  if (!state.hostId) { state.hostId = socket.id; socket.emit('host', true); }

  socket.on('claim-host', () => {
    if (!state.hostId) { state.hostId = socket.id; socket.emit('host', true); }
  });

  socket.on('select', id => {
    if (socket.id !== state.hostId || !state.contestants.some(c => c.id === id)) return;
    state.current = id;
    state.playing = false;
    state.startedAt = null;
    state.pausedAt = 0;
    broadcast();
  });

  socket.on('play', () => {
    if (socket.id !== state.hostId || !state.current) return;
    state.playing = true;
    state.startedAt = Date.now() - (state.pausedAt * 1000);
    broadcast();
  });

  socket.on('pause', elapsed => {
    if (socket.id !== state.hostId) return;
    state.pausedAt = Number(elapsed) || 0;
    state.playing = false;
    state.startedAt = null;
    broadcast();
  });

  socket.on('seek', elapsed => {
    if (socket.id !== state.hostId) return;
    state.pausedAt = Math.max(0, Number(elapsed) || 0);
    if (state.playing) state.startedAt = Date.now() - state.pausedAt * 1000;
    broadcast();
  });

  socket.on('disconnect', () => {
    if (socket.id === state.hostId) {
      state.hostId = null;
      io.sockets.sockets.forEach(s => { if (!state.hostId) { state.hostId = s.id; s.emit('host', true); } });
    }
    broadcast();
  });
});

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Upload failed.' }));

server.listen(PORT, HOST, () => console.log(`UG COMP running at http://localhost:${PORT}`));
