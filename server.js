const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;
const PUBLIC_URL = 'https://sandbox-testing-production.up.railway.app';
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// ── Colour picker state ──
const roomTokens = new Map(); // QR token → username

// ── Chess state ──
const onlineUsers = new Map();  // username → Set<socketId>
const pendingInvites = new Map(); // inviteId → { from, to, timer }
const activeGames = new Map();  // gameId → { white, black }
const userInGame = new Map();   // username → gameId

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function broadcastOnlineUsers() {
  const list = Array.from(onlineUsers.keys()).map(u => ({
    username: u,
    inGame: userInGame.has(u)
  }));
  io.emit('chess:online-users', list);
}

function cancelUserInvites(username) {
  for (const [id, invite] of [...pendingInvites]) {
    if (invite.from === username || invite.to === username) {
      clearTimeout(invite.timer);
      pendingInvites.delete(id);
      const other = invite.from === username ? invite.to : invite.from;
      io.to(`user:${other}`).emit('chess:invite-cancelled', { inviteId: id, reason: 'offline' });
    }
  }
}

app.use(express.json());
app.use(express.static('public'));

// Serve chess.js ESM bundle for browser import
app.get('/lib/chess.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/chess.js/dist/esm/chess.js'));
});
app.use(session({
  secret: process.env.SESSION_SECRET || 'sandbox-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── Auth routes ──
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const accounts = loadAccounts();
  if (accounts[username])
    return res.status(409).json({ error: 'Username already taken' });
  const passwordHash = await bcrypt.hash(password, 12);
  accounts[username] = { passwordHash, lastColour: null };
  saveAccounts(accounts);
  req.session.username = username;
  res.json({ ok: true, username, lastColour: null });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const accounts = loadAccounts();
  const account = accounts[username];
  if (!account) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, account.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.username = username;
  res.json({ ok: true, username, lastColour: account.lastColour });
});

app.post('/auth/logout', (req, res) => {
  if (req.session.roomToken) roomTokens.delete(req.session.roomToken);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth/me', (req, res) => {
  if (!req.session.username) return res.json({ user: null, lastColour: null });
  const accounts = loadAccounts();
  const account = accounts[req.session.username];
  res.json({ user: req.session.username, lastColour: account?.lastColour ?? null });
});

app.get('/qrcode', (req, res) => {
  if (!req.session.username)
    return res.status(401).json({ error: 'Not logged in' });
  if (!req.session.roomToken) req.session.roomToken = crypto.randomUUID();
  roomTokens.set(req.session.roomToken, req.session.username);
  const url = `${PUBLIC_URL}/phone.html?room=${req.session.roomToken}`;
  QRCode.toDataURL(url, { width: 256, margin: 2 })
    .then(qr => res.json({ qr, url }))
    .catch(() => res.status(500).json({ error: 'QR generation failed' }));
});

// Chess page uses this to verify the player and get their colour
app.get('/chess/game/:gameId', (req, res) => {
  if (!req.session.username)
    return res.status(401).json({ error: 'Not logged in' });
  const game = activeGames.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.white !== req.session.username && game.black !== req.session.username)
    return res.status(403).json({ error: 'Not your game' });
  const color = game.white === req.session.username ? 'white' : 'black';
  const opponent = color === 'white' ? game.black : game.white;
  res.json({ ok: true, color, opponent, username: req.session.username });
});

// ── Socket.io ──
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Desktop registers as online when logging in
  socket.on('join-user-room', (username) => {
    socket.join(`user:${username}`);
    socket.data.username = username;
    if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
    onlineUsers.get(username).add(socket.id);
    broadcastOnlineUsers();
  });

  // Desktop unregisters on logout or account switch
  socket.on('leave-user-room', (username) => {
    socket.leave(`user:${username}`);
    if (socket.data.username === username) {
      socket.data.username = null;
      if (onlineUsers.has(username)) {
        onlineUsers.get(username).delete(socket.id);
        if (onlineUsers.get(username).size === 0) {
          onlineUsers.delete(username);
          cancelUserInvites(username);
        }
      }
      broadcastOnlineUsers();
    }
  });

  // Phone joins its user room via QR token
  socket.on('join-room', (token) => {
    const username = roomTokens.get(token);
    if (username) {
      socket.join(`user:${username}`);
      socket.data.username = username;
    }
  });

  socket.on('colour-pick', (colour) => {
    if (!socket.data.username) return;
    io.to(`user:${socket.data.username}`).emit('colour-update', colour);
    const accounts = loadAccounts();
    if (accounts[socket.data.username]) {
      accounts[socket.data.username].lastColour = colour;
      saveAccounts(accounts);
    }
  });

  // ── Chess: invite system ──
  socket.on('chess:invite', (toUsername) => {
    const from = socket.data.username;
    if (!from || from === toUsername) return;
    if (!onlineUsers.has(toUsername)) return;
    if (userInGame.has(from) || userInGame.has(toUsername)) return;
    // Prevent duplicate invites to the same person
    for (const inv of pendingInvites.values()) {
      if (inv.from === from && inv.to === toUsername) return;
    }

    const inviteId = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (!pendingInvites.has(inviteId)) return;
      pendingInvites.delete(inviteId);
      io.to(`user:${from}`).emit('chess:invite-cancelled', { inviteId, reason: 'timeout' });
      io.to(`user:${toUsername}`).emit('chess:invite-cancelled', { inviteId, reason: 'timeout' });
    }, 30000);

    pendingInvites.set(inviteId, { from, to: toUsername, timer });
    socket.emit('chess:invite-sent', { inviteId, to: toUsername });
    io.to(`user:${toUsername}`).emit('chess:invite-received', { inviteId, from });
  });

  socket.on('chess:invite-response', ({ inviteId, accepted }) => {
    const invite = pendingInvites.get(inviteId);
    if (!invite) return;
    clearTimeout(invite.timer);
    pendingInvites.delete(inviteId);

    if (accepted) {
      const gameId = crypto.randomUUID();
      const [white, black] = Math.random() < 0.5
        ? [invite.from, invite.to]
        : [invite.to, invite.from];
      activeGames.set(gameId, { white, black, chess: new Chess(), lastMove: null });
      userInGame.set(white, gameId);
      userInGame.set(black, gameId);
      io.to(`user:${white}`).emit('chess:game-start', { gameId, color: 'white' });
      io.to(`user:${black}`).emit('chess:game-start', { gameId, color: 'black' });
      broadcastOnlineUsers();
    } else {
      io.to(`user:${invite.from}`).emit('chess:invite-declined', { by: invite.to });
    }
  });

  socket.on('chess:cancel-invite', (inviteId) => {
    const invite = pendingInvites.get(inviteId);
    if (!invite || invite.from !== socket.data.username) return;
    clearTimeout(invite.timer);
    pendingInvites.delete(inviteId);
    io.to(`user:${invite.to}`).emit('chess:invite-cancelled', { inviteId, reason: 'cancelled' });
  });

  // Chess page joins the game room and receives current board state
  socket.on('chess:join-game', (gameId) => {
    const game = activeGames.get(gameId);
    if (!game) return;
    const username = socket.data.username;
    if (game.white !== username && game.black !== username) return;
    socket.join(`game:${gameId}`);
    socket.data.gameId = gameId;
    const color = game.white === username ? 'white' : 'black';
    const opponent = color === 'white' ? game.black : game.white;
    socket.emit('chess:game-info', { color, opponent });
    socket.emit('chess:state', {
      fen: game.chess.fen(),
      turn: game.chess.turn(),
      lastMove: game.lastMove
    });
  });

  // Chess page submits a move; server validates and broadcasts new state
  socket.on('chess:move', ({ gameId, from, to, promotion }) => {
    const game = activeGames.get(gameId);
    if (!game || socket.data.gameId !== gameId) return;
    const username = socket.data.username;
    const myColor = game.white === username ? 'w' : game.black === username ? 'b' : null;
    if (!myColor || game.chess.turn() !== myColor) return;

    let move;
    try { move = game.chess.move({ from, to, promotion: promotion || 'q' }); }
    catch { return; }
    if (!move) return;

    game.lastMove = { from: move.from, to: move.to };
    io.to(`game:${gameId}`).emit('chess:state', {
      fen: game.chess.fen(),
      turn: game.chess.turn(),
      lastMove: game.lastMove
    });

    if (game.chess.isGameOver()) {
      let result;
      if (game.chess.isCheckmate()) {
        result = { type: 'checkmate', winner: username };
      } else {
        result = { type: 'draw', reason: game.chess.isStalemate() ? 'Stalemate' : 'Draw' };
      }
      io.to(`game:${gameId}`).emit('chess:game-over', result);
      userInGame.delete(game.white);
      userInGame.delete(game.black);
      activeGames.delete(gameId);
      broadcastOnlineUsers();
    }
  });

  // Chess chat
  socket.on('chess:chat', ({ gameId, text }) => {
    const username = socket.data.username;
    const game = activeGames.get(gameId);
    if (!game || socket.data.gameId !== gameId) return;
    if (game.white !== username && game.black !== username) return;
    if (!text || typeof text !== 'string') return;
    const safeText = text.trim().slice(0, 200);
    if (!safeText) return;
    io.to(`game:${gameId}`).emit('chess:chat', { username, text: safeText, ts: Date.now() });
  });

  // Chess page: clean up game state when game ends
  socket.on('chess:game-end', (gameId) => {
    const game = activeGames.get(gameId);
    if (!game) return;
    userInGame.delete(game.white);
    userInGame.delete(game.black);
    activeGames.delete(gameId);
    broadcastOnlineUsers();
  });

  socket.on('disconnect', () => {
    const username = socket.data.username;

    // If this socket was in an active chess game, notify the opponent and clean up
    const gId = socket.data.gameId;
    if (gId && username) {
      const game = activeGames.get(gId);
      if (game) {
        io.to(`game:${gId}`).emit('chess:opponent-left', { username });
        userInGame.delete(game.white);
        userInGame.delete(game.black);
        activeGames.delete(gId);
      }
    }

    if (username && onlineUsers.has(username)) {
      onlineUsers.get(username).delete(socket.id);
      if (onlineUsers.get(username).size === 0) {
        onlineUsers.delete(username);
        cancelUserInvites(username);
      }
      broadcastOnlineUsers();
    }
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Sandbox Testing running!`);
  console.log(`   Desktop → ${PUBLIC_URL}`);
  console.log(`   Phone   → ${PUBLIC_URL}/phone.html\n`);
});
