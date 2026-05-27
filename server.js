const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { setupAuth } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Auth scaffold (Google/Facebook) — guest-only until credentials are provided as env vars.
setupAuth(app);

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
const PREFIX_MODES = ['shuffle', 'same'];
const NEXT_TURN_DELAY_MS = 1200;
const MAX_PLAYERS = 12;
const LOBBY = 'lobby';

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

function makeRoom(socketId, { name, isPublic, turnTimeSec, prefixMode }) {
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
      prefixMode: PREFIX_MODES.includes(prefixMode) ? prefixMode : 'shuffle',
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
  return room.players.map((p) => ({ id: p.id, username: p.username, alive: p.alive }));
}

function publicSettings(room) {
  return {
    turnTimeSec: Math.round(room.settings.turnTimeMs / 1000),
    prefixMode: room.settings.prefixMode,
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
      prefixMode: r.settings.prefixMode,
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
    eliminatePlayer(roomCode, current.id, 'Time ran out');
  }, room.settings.turnTimeMs);
}

function eliminatePlayer(roomCode, playerId, reason) {
  const room = rooms[roomCode];
  if (!room) return;
  const player = room.players.find((p) => p.id === playerId);
  if (!player || !player.alive) return;

  clearRoomTimer(room);
  player.alive = false;

  io.to(roomCode).emit('player-eliminated', {
    playerId,
    username: player.username,
    reason,
    players: publicPlayers(room),
  });
  const sock = io.sockets.sockets.get(playerId);
  if (sock) sock.emit('you-eliminated', { reason });

  emitGameResult(room, player, false, alivePlayers(room).length + 1);

  if (alivePlayers(room).length <= 1) {
    setTimeout(() => endGame(roomCode), NEXT_TURN_DELAY_MS);
    return;
  }

  advanceTurnIndex(room);
  setTimeout(() => startTurn(roomCode), NEXT_TURN_DELAY_MS);
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearRoomTimer(room);
  const alive = alivePlayers(room);
  const winner = alive[0] || null;
  io.to(roomCode).emit('winner', {
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.username : null,
    wordsUsed: Array.from(room.usedWords),
  });
  if (winner) emitGameResult(room, winner, true, 1);
  room.started = false;
  // Drop players whose sockets disconnected during the game (avoids ghost rooms).
  room.players = room.players.filter((p) => io.sockets.sockets.get(p.id));
  if (room.players.length === 0) {
    delete rooms[roomCode];
    broadcastLobby();
    return;
  }
  if (!room.players.find((p) => p.id === room.creatorId)) room.creatorId = room.players[0].id;
  room.players.forEach((p) => (p.alive = true));
  room.usedWords = new Set();
  broadcastRoom(roomCode);
  broadcastLobby();
}

function emitGameResult(room, player, won, placement) {
  const sock = io.sockets.sockets.get(player.id);
  if (!sock) return;
  const s = player.stats || { validWords: 0, longestWord: '', fastestMs: null };
  sock.emit('game-result', {
    won,
    placement,
    totalPlayers: room.startingPlayerCount || room.players.length,
    survivedMs: Math.max(0, Date.now() - (room.gameStartedAt || Date.now())),
    validWords: s.validWords,
    longestWord: s.longestWord,
    fastestMs: s.fastestMs,
  });
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
      prefixMode: raw ? raw.prefixMode : undefined,
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
    const prefixMode = raw ? raw.prefixMode : undefined;
    if (ALLOWED_TURN_TIMES.includes(turnTimeSec)) {
      room.settings.turnTimeMs = turnTimeSec * 1000;
    }
    if (PREFIX_MODES.includes(prefixMode)) {
      room.settings.prefixMode = prefixMode;
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
    });
    room.usedWords = new Set();
    room.currentTurnIndex = Math.floor(Math.random() * room.players.length);
    room.currentPrefix = randomPrefix();
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

    const word = (raw && typeof raw.word === 'string' ? raw.word : '').trim().toLowerCase();
    if (!word) {
      eliminatePlayer(roomCode, socket.id, 'Submitted an empty word');
      return;
    }
    if (!/^[a-z]+$/.test(word)) {
      eliminatePlayer(roomCode, socket.id, `"${word}" contains non-letters`);
      return;
    }
    if (!word.startsWith(room.currentPrefix)) {
      eliminatePlayer(roomCode, socket.id, `"${word}" doesn't start with "${room.currentPrefix}"`);
      return;
    }
    if (room.usedWords.has(word)) {
      eliminatePlayer(roomCode, socket.id, `"${word}" was already used`);
      return;
    }
    if (!words.has(word)) {
      eliminatePlayer(roomCode, socket.id, `"${word}" is not a valid English word`);
      return;
    }

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
    io.to(roomCode).emit('word-accepted', {
      word,
      playerId: socket.id,
      username: current.username,
    });

    if (room.settings.prefixMode === 'shuffle') {
      room.currentPrefix = randomPrefix(room.currentPrefix);
    }
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
server.listen(PORT, () => {
  console.log(`Word Race running at http://localhost:${PORT}`);
});
