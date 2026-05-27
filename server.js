const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { setupAuth } = require('./auth');
const store = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '64kb' }));

// Auth scaffold (Google/Facebook) — guest-only until credentials are provided as env vars.
setupAuth(app);

// ---------- Account profile persistence (cross-device sync) ----------
function sanitizeProfile(p) {
  p = p || {};
  const num = (v, max) => { let n = Math.floor(Number(v) || 0); if (n < 0) n = 0; return max ? Math.min(n, max) : n; };
  const ach = {};
  if (p.achievements && typeof p.achievements === 'object') {
    Object.keys(p.achievements).slice(0, 50).forEach((k) => { ach[String(k).slice(0, 40)] = Number(p.achievements[k]) || Date.now(); });
  }
  return {
    username: typeof p.username === 'string' ? p.username.slice(0, 20) : '',
    gamesPlayed: num(p.gamesPlayed, 1e7), gamesWon: num(p.gamesWon, 1e7), gamesLost: num(p.gamesLost, 1e7),
    totalPlayMs: num(p.totalPlayMs, 1e12), totalValidWords: num(p.totalValidWords, 1e8),
    longestWord: typeof p.longestWord === 'string' ? p.longestWord.slice(0, 30) : '',
    fastestMs: p.fastestMs == null ? null : num(p.fastestMs, 600000),
    currentStreak: num(p.currentStreak, 1e6), bestStreak: num(p.bestStreak, 1e6),
    xp: num(p.xp, 1e9), achievements: ach,
  };
}
// Monotonic merge: keep the best of each field so progress is never lost across devices.
function mergeProfiles(stored, incoming) {
  const s = sanitizeProfile(incoming);
  if (!stored) return s;
  return {
    username: s.username || stored.username || '',
    gamesPlayed: Math.max(stored.gamesPlayed || 0, s.gamesPlayed),
    gamesWon: Math.max(stored.gamesWon || 0, s.gamesWon),
    gamesLost: Math.max(stored.gamesLost || 0, s.gamesLost),
    totalPlayMs: Math.max(stored.totalPlayMs || 0, s.totalPlayMs),
    totalValidWords: Math.max(stored.totalValidWords || 0, s.totalValidWords),
    longestWord: (stored.longestWord || '').length >= s.longestWord.length ? (stored.longestWord || '') : s.longestWord,
    fastestMs: stored.fastestMs == null ? s.fastestMs : s.fastestMs == null ? stored.fastestMs : Math.min(stored.fastestMs, s.fastestMs),
    currentStreak: Math.max(stored.currentStreak || 0, s.currentStreak),
    bestStreak: Math.max(stored.bestStreak || 0, s.bestStreak),
    xp: Math.max(stored.xp || 0, s.xp),
    achievements: Object.assign({}, stored.achievements || {}, s.achievements),
  };
}
function identityFor(req) {
  if (req.user && req.user.id) return { id: 'u:' + req.user.id, kind: 'account' };
  const gid = (req.query && req.query.guestId) || (req.body && req.body.guestId);
  if (typeof gid === 'string' && /^[a-zA-Z0-9_]{6,64}$/.test(gid)) return { id: 'g:' + gid, kind: 'guest' };
  return null;
}
// Digital Asset Links for the Android TWA (PWABuilder / Play Store).
// Set TWA_PACKAGE + TWA_FINGERPRINT (SHA-256, colon-separated) as Render env
// vars after you generate the Android package — no redeploy/code change needed.
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = process.env.TWA_PACKAGE || '';
  const fp = process.env.TWA_FINGERPRINT || '';
  if (!pkg || !fp) return res.json([]);
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: pkg,
        sha256_cert_fingerprints: fp.split(',').map((s) => s.trim()).filter(Boolean),
      },
    },
  ]);
});

app.get('/api/profile', async (req, res) => {
  const idn = identityFor(req);
  const backend = store.info().backend;
  if (!idn) return res.json({ profile: null, identity: null, backend });
  const profile = await store.getProfile(idn.id).catch(() => null);
  res.json({ profile, identity: idn.kind, backend });
});
app.post('/api/profile', async (req, res) => {
  const idn = identityFor(req);
  if (!idn) return res.status(400).json({ error: 'no identity' });
  const incoming = sanitizeProfile(req.body && req.body.profile);
  let toSave;
  if (req.body && req.body.replace) toSave = incoming;
  else { const stored = await store.getProfile(idn.id).catch(() => null); toSave = mergeProfiles(stored, incoming); }
  const saved = await store.saveProfile(idn.id, toSave).catch(() => null);
  res.json({ profile: saved, identity: idn.kind });
});

app.use(express.static(path.join(__dirname, 'public')));

let words;
try {
  const list = require('an-array-of-english-words');
  words = new Set(list.map((w) => w.toLowerCase()));
} catch (e) {
  const fallback = path.join(__dirname, 'public', 'wordlist.txt');
  if (fs.existsSync(fallback)) {
    words = new Set(
      fs.readFileSync(fallback, 'utf-8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean)
    );
  } else {
    console.error('No wordlist available. Run `npm install` first.');
    words = new Set();
  }
}
console.log(`Loaded ${words.size} words.`);

const PREFIXES = ['bo', 'st', 'pr', 'tr', 'ch', 'gr', 'fl', 'br', 'sp', 'cr', 'dr', 'fr', 'cl', 'pl', 'bl', 'sl', 'gl', 'sw', 'tw', 'wh'];
const DEFAULT_TURN_TIME_MS = 30000;
const ALLOWED_TURN_TIMES = [15, 30, 45, 60]; // seconds the host may choose
const NEXT_TURN_DELAY_MS = 1200;
const MAX_PLAYERS = 12;
const LOBBY = 'lobby';
// Single game model: one prefix all match, +10 per correct word, -20 per
// mistake, 3 mistakes and you're out; most points wins.
const CORRECT_POINTS = 10;
const MISTAKE_PENALTY = 20;
const MAX_MISTAKES = 3;

const rooms = Object.create(null);

// ---------- helpers ----------
function sanitizeName(u) {
  return typeof u === 'string' ? u.trim().slice(0, 20) : '';
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function makeRoom(socketId, { name, isPublic, turnTimeSec }) {
  const code = genCode();
  rooms[code] = {
    code,
    name: name || 'Game room',
    isPublic: isPublic !== false,
    createdAt: Date.now(),
    players: [],
    started: false,
    currentTurnIndex: 0,
    currentPrefix: null,
    usedWords: new Set(),
    timer: null,
    creatorId: socketId,
    settings: {
      turnTimeMs: ALLOWED_TURN_TIMES.includes(Number(turnTimeSec)) ? Number(turnTimeSec) * 1000 : DEFAULT_TURN_TIME_MS,
    },
  };
  return rooms[code];
}

function randomPrefix(exclude) {
  if (PREFIXES.length === 1) return PREFIXES[0];
  let p;
  do {
    p = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
  } while (p === exclude);
  return p;
}

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function publicPlayers(room) {
  return room.players.map((p) => ({
    id: p.id,
    username: p.username,
    alive: p.alive,
    score: p.score == null ? 0 : p.score,
    mistakes: p.mistakes == null ? 0 : p.mistakes,
  }));
}

function publicSettings(room) {
  return {
    turnTimeSec: Math.round(room.settings.turnTimeMs / 1000),
    maxMistakes: MAX_MISTAKES,
  };
}

function hostName(room) {
  const host = room.players.find((p) => p.id === room.creatorId) || room.players[0];
  return host ? host.username : '—';
}

function roomSummaries() {
  const list = [];
  for (const code in rooms) {
    const r = rooms[code];
    if (!r.isPublic || r.players.length === 0) continue;
    list.push({
      code: r.code,
      name: r.name,
      host: hostName(r),
      players: r.players.length,
      max: MAX_PLAYERS,
      status: r.started ? 'playing' : 'waiting',
      playMs: r.started ? Math.max(0, Date.now() - (r.gameStartedAt || Date.now())) : 0,
      turnTimeSec: Math.round(r.settings.turnTimeMs / 1000),
      full: r.players.length >= MAX_PLAYERS,
    });
  }
  list.sort((a, b) => (a.status === b.status ? b.players - a.players : a.status === 'waiting' ? -1 : 1));
  return list;
}

function broadcastLobby() {
  io.to(LOBBY).emit('lobby-update', { rooms: roomSummaries() });
}

function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('room-update', {
    roomCode,
    roomName: room.name,
    isPublic: room.isPublic,
    players: publicPlayers(room),
    creatorId: room.creatorId,
    started: room.started,
    settings: publicSettings(room),
  });
}

function validateJoin(room, username) {
  if (!room) return 'Room not found — check the code.';
  if (room.started) return 'That game has already started.';
  if (room.players.find((p) => p.username.toLowerCase() === username.toLowerCase())) return 'That name is taken in this room.';
  if (room.players.length >= MAX_PLAYERS) return `Room is full (${MAX_PLAYERS} max).`;
  return null;
}

function joinRoomInternal(socket, room, username) {
  socket.leave(LOBBY);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.username = username;
  room.players.push({ id: socket.id, username, alive: true });
  if (room.players.length === 1) room.creatorId = socket.id;
  socket.emit('joined', {
    roomCode: room.code,
    roomName: room.name,
    isPublic: room.isPublic,
    playerId: socket.id,
    isCreator: room.creatorId === socket.id,
  });
  broadcastRoom(room.code);
  broadcastLobby();
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function advanceTurnIndex(room) {
  const n = room.players.length;
  for (let i = 0; i < n; i++) {
    room.currentTurnIndex = (room.currentTurnIndex + 1) % n;
    if (room.players[room.currentTurnIndex].alive) return;
  }
}

function startTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.started) return;

  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    endGame(roomCode);
    return;
  }

  if (!room.players[room.currentTurnIndex] || !room.players[room.currentTurnIndex].alive) {
    advanceTurnIndex(room);
  }

  const current = room.players[room.currentTurnIndex];
  room.turnStart = Date.now();

  io.to(roomCode).emit('turn-update', {
    prefix: room.currentPrefix,
    currentPlayerId: current.id,
    currentPlayerName: current.username,
    timeLeftMs: room.settings.turnTimeMs,
    usedWords: Array.from(room.usedWords),
    players: publicPlayers(room),
  });

  clearRoomTimer(room);
  room.timer = setTimeout(() => {
    mistake(roomCode, current, 'Ran out of time');
  }, room.settings.turnTimeMs);
}

function eliminatePlayer(roomCode, playerId, reason) {
  const room = rooms[roomCode];
  if (!room) return;
  const player = room.players.find((p) => p.id === playerId);
  if (!player || !player.alive) return;

  clearRoomTimer(room);
  player.alive = false;
  player.eliminatedAt = Date.now();

  io.to(roomCode).emit('player-eliminated', {
    playerId,
    username: player.username,
    reason,
    players: publicPlayers(room),
  });
  const sock = io.sockets.sockets.get(playerId);
  if (sock) sock.emit('you-eliminated', { reason });

  // Match ends once only one player is left; the winner is decided by points.
  if (alivePlayers(room).length <= 1) {
    setTimeout(() => endGame(roomCode), NEXT_TURN_DELAY_MS);
    return;
  }

  advanceTurnIndex(room);
  setTimeout(() => startTurn(roomCode), NEXT_TURN_DELAY_MS);
}

// A wrong/duplicate word or timeout costs points and one of the player's 3
// allowed mistakes. The third mistake knocks them out. The turn then passes on.
function mistake(roomCode, player, reason) {
  const room = rooms[roomCode];
  if (!room || !player || !player.alive) return;
  clearRoomTimer(room);
  player.score = (player.score || 0) - MISTAKE_PENALTY;
  player.mistakes = (player.mistakes || 0) + 1;
  io.to(roomCode).emit('word-rejected', {
    playerId: player.id,
    username: player.username,
    reason,
    points: -MISTAKE_PENALTY,
    score: player.score,
    mistakes: player.mistakes,
    remaining: Math.max(0, MAX_MISTAKES - player.mistakes),
    players: publicPlayers(room),
  });
  if (player.mistakes >= MAX_MISTAKES) {
    eliminatePlayer(roomCode, player.id, reason + ` — out after ${MAX_MISTAKES} mistakes`);
    return;
  }
  advanceTurnIndex(room);
  setTimeout(() => startTurn(roomCode), 900);
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearRoomTimer(room);
  const endTime = Date.now();
  // Most points wins. Rank all players by score (desc).
  const ranked = room.players.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  const winner = ranked[0] || null;
  const scoreboard = ranked.map((p) => ({ username: p.username, score: p.score || 0, mistakes: p.mistakes || 0 }));
  io.to(roomCode).emit('winner', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.username : null,
    wordsUsed: Array.from(room.usedWords),
    scoreboard,
  });
  // Per-player results for profile XP / streaks.
  ranked.forEach((p, idx) => {
    const sock = io.sockets.sockets.get(p.id);
    if (!sock) return;
    const s = p.stats || { validWords: 0, longestWord: '', fastestMs: null };
    sock.emit('game-result', {
      won: idx === 0,
      placement: idx + 1,
      totalPlayers: room.startingPlayerCount || room.players.length,
      survivedMs: Math.max(0, (p.eliminatedAt || endTime) - (room.gameStartedAt || endTime)),
      score: p.score || 0,
      validWords: s.validWords,
      longestWord: s.longestWord,
      fastestMs: s.fastestMs,
    });
  });
  room.started = false;
  // Drop players whose sockets disconnected during the game (avoids ghost rooms).
  room.players = room.players.filter((p) => io.sockets.sockets.get(p.id));
  if (room.players.length === 0) {
    delete rooms[roomCode];
    broadcastLobby();
    return;
  }
  if (!room.players.find((p) => p.id === room.creatorId)) room.creatorId = room.players[0].id;
  room.players.forEach((p) => { p.alive = true; p.score = 0; p.mistakes = 0; p.eliminatedAt = null; });
  room.usedWords = new Set();
  broadcastRoom(roomCode);
  broadcastLobby();
}

io.on('connection', (socket) => {
  // ---- Lobby browsing ----
  socket.on('enter-lobby', () => {
    socket.join(LOBBY);
    socket.emit('lobby-update', { rooms: roomSummaries() });
  });
  socket.on('leave-lobby', () => {
    socket.leave(LOBBY);
  });

  // ---- Peek at a room (for invite links) ----
  socket.on('peek-room', (raw) => {
    const code = (raw && typeof raw.code === 'string' ? raw.code : '').trim().toUpperCase().slice(0, 10);
    const r = rooms[code];
    if (!r) {
      socket.emit('room-peek', { code, exists: false });
      return;
    }
    socket.emit('room-peek', {
      code,
      exists: true,
      name: r.name,
      host: hostName(r),
      players: r.players.length,
      max: MAX_PLAYERS,
      status: r.started ? 'playing' : 'waiting',
      full: r.players.length >= MAX_PLAYERS,
    });
  });

  // ---- Create a brand-new room ----
  socket.on('create-room', (raw) => {
    const username = sanitizeName(raw && raw.username);
    if (!username) {
      socket.emit('error-msg', { message: 'Pick a name first.' });
      return;
    }
    let name = typeof (raw && raw.name) === 'string' ? raw.name.trim().slice(0, 30) : '';
    if (!name) name = `${username}'s room`;
    const room = makeRoom(socket.id, {
      name,
      isPublic: raw ? raw.isPublic : true,
      turnTimeSec: raw ? raw.turnTimeSec : undefined,
    });
    joinRoomInternal(socket, room, username);
  });

  // ---- Join an existing room by code (or from the browser) ----
  socket.on('join-room', (raw) => {
    const username = sanitizeName(raw && raw.username);
    const roomCode = (raw && typeof raw.roomCode === 'string' ? raw.roomCode : '').trim().toUpperCase().slice(0, 10);
    if (!username || !roomCode) {
      socket.emit('error-msg', { message: 'Name and room code required.' });
      return;
    }
    const room = rooms[roomCode];
    const err = validateJoin(room, username);
    if (err) {
      socket.emit('error-msg', { message: err });
      return;
    }
    joinRoomInternal(socket, room, username);
  });

  // ---- Quick play: join the busiest open public room, or spin one up ----
  socket.on('quick-play', (raw) => {
    const username = sanitizeName(raw && raw.username);
    if (!username) {
      socket.emit('error-msg', { message: 'Pick a name first.' });
      return;
    }
    let best = null;
    for (const code in rooms) {
      const r = rooms[code];
      if (r.isPublic && !r.started && r.players.length < MAX_PLAYERS &&
          !r.players.find((p) => p.username.toLowerCase() === username.toLowerCase())) {
        if (!best || r.players.length > best.players.length) best = r;
      }
    }
    if (!best) best = makeRoom(socket.id, { name: `${username}'s room`, isPublic: true });
    joinRoomInternal(socket, best, username);
  });

  socket.on('update-settings', (raw) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.creatorId !== socket.id) {
      socket.emit('error-msg', { message: 'Only the host can change settings.' });
      return;
    }
    if (room.started) return;
    const turnTimeSec = raw ? Number(raw.turnTimeSec) : NaN;
    if (ALLOWED_TURN_TIMES.includes(turnTimeSec)) {
      room.settings.turnTimeMs = turnTimeSec * 1000;
    }
    if (raw && typeof raw.isPublic === 'boolean') room.isPublic = raw.isPublic;
    broadcastRoom(roomCode);
    broadcastLobby();
  });

  socket.on('start-game', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.creatorId !== socket.id) {
      socket.emit('error-msg', { message: 'Only the host can start the game.' });
      return;
    }
    if (room.players.length < 2) {
      socket.emit('error-msg', { message: 'Need at least 2 players to start.' });
      return;
    }
    if (room.started) return;

    room.started = true;
    room.gameStartedAt = Date.now();
    room.startingPlayerCount = room.players.length;
    room.players.forEach((p) => {
      p.alive = true;
      p.stats = { validWords: 0, longestWord: '', fastestMs: null };
      p.score = 0;
      p.mistakes = 0;
      p.eliminatedAt = null;
    });
    room.usedWords = new Set();
    room.currentTurnIndex = Math.floor(Math.random() * room.players.length);
    room.currentPrefix = randomPrefix(); // one prefix for the whole match
    io.to(roomCode).emit('game-started', { players: publicPlayers(room) });
    broadcastRoom(roomCode);
    broadcastLobby();
    startTurn(roomCode);
  });

  socket.on('submit-word', (raw) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.started) return;
    const current = room.players[room.currentTurnIndex];
    if (!current || current.id !== socket.id || !current.alive) return;

    const reject = (reason) => mistake(roomCode, current, reason);

    const word = (raw && typeof raw.word === 'string' ? raw.word : '').trim().toLowerCase();
    if (!word) return reject('Submitted an empty word');
    if (!/^[a-z]+$/.test(word)) return reject(`"${word}" contains non-letters`);
    if (!word.startsWith(room.currentPrefix)) return reject(`"${word}" doesn't start with "${room.currentPrefix}"`);
    if (room.usedWords.has(word)) return reject(`"${word}" was already used`);
    if (!words.has(word)) return reject(`"${word}" is not a valid English word`);

    clearRoomTimer(room);
    room.usedWords.add(word);
    if (current.stats) {
      current.stats.validWords += 1;
      if (word.length > current.stats.longestWord.length) current.stats.longestWord = word;
      const responseMs = Date.now() - (room.turnStart || Date.now());
      if (current.stats.fastestMs == null || responseMs < current.stats.fastestMs) {
        current.stats.fastestMs = responseMs;
      }
    }
    current.score = (current.score || 0) + CORRECT_POINTS;
    io.to(roomCode).emit('word-accepted', {
      word,
      playerId: socket.id,
      username: current.username,
      points: CORRECT_POINTS,
      score: current.score,
      players: publicPlayers(room),
    });

    // Same prefix for the whole match — never rotates.
    advanceTurnIndex(room);
    setTimeout(() => startTurn(roomCode), 600);
  });

  socket.on('leave-room', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;
  const room = rooms[roomCode];
  if (!room) return;
  const idx = room.players.findIndex((p) => p.id === socket.id);
  if (idx === -1) return;
  const player = room.players[idx];

  if (room.started && player.alive) {
    const wasCurrent = room.players[room.currentTurnIndex].id === socket.id;
    player.alive = false;
    io.to(roomCode).emit('player-eliminated', {
      playerId: socket.id,
      username: player.username,
      reason: 'Left the game',
      players: publicPlayers(room),
    });
    if (alivePlayers(room).length <= 1) {
      setTimeout(() => endGame(roomCode), NEXT_TURN_DELAY_MS);
    } else if (wasCurrent) {
      clearRoomTimer(room);
      advanceTurnIndex(room);
      setTimeout(() => startTurn(roomCode), NEXT_TURN_DELAY_MS);
    }
    broadcastLobby();
  } else {
    room.players.splice(idx, 1);
    if (room.creatorId === socket.id && room.players.length > 0) {
      room.creatorId = room.players[0].id;
    }
    if (room.players.length === 0) {
      clearRoomTimer(room);
      delete rooms[roomCode];
    } else {
      broadcastRoom(roomCode);
    }
    broadcastLobby();
  }
  socket.data.roomCode = null;
}

const PORT = process.env.PORT || 3000;
store.init().catch(() => {}).then(() => {
  server.listen(PORT, () => {
    console.log(`Word Race running at http://localhost:${PORT}`);
  });
});
