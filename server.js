const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = 'https://sandbox-testing-production.up.railway.app';

// Serve static files from /public
app.use(express.static('public'));

// Endpoint: generate QR code pointing to /phone.html on Railway URL
app.get('/qrcode', async (req, res) => {
  const url = `${PUBLIC_URL}/phone.html`;
  const qr = await QRCode.toDataURL(url, { width: 256, margin: 2 });
  res.json({ qr, url });
});

// Socket.io: relay colour events from phone → desktop
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('colour-pick', (colour) => {
    // Broadcast to all OTHER connected clients (i.e. the desktop)
    socket.broadcast.emit('colour-update', colour);
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