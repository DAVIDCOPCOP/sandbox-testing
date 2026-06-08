const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;
const PUBLIC_URL = 'https://sandbox-testing-production.up.railway.app';
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// room token (uuid) → username, cleared on server restart
const roomTokens = new Map();

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sandbox-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

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

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Desktop joins its user room after login / page load
  socket.on('join-user-room', (username) => {
    socket.join(`user:${username}`);
  });

  // Desktop leaves its room on logout or account switch
  socket.on('leave-user-room', (username) => {
    socket.leave(`user:${username}`);
  });

  // Phone joins its user room via the QR room token
  socket.on('join-room', (token) => {
    const username = roomTokens.get(token);
    if (username) {
      socket.join(`user:${username}`);
      socket.data.username = username;
    }
  });

  socket.on('colour-pick', (colour) => {
    if (!socket.data.username) return; // login required
    io.to(`user:${socket.data.username}`).emit('colour-update', colour);
    const accounts = loadAccounts();
    if (accounts[socket.data.username]) {
      accounts[socket.data.username].lastColour = colour;
      saveAccounts(accounts);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Sandbox Testing running!`);
  console.log(`   Desktop → ${PUBLIC_URL}`);
  console.log(`   Phone   → ${PUBLIC_URL}/phone.html\n`);
});
