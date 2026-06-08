const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// Serve static files from /public
app.use(express.static('public'));

// Get local IP so phone can connect to the same machine
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// Endpoint: generate QR code pointing to /phone.html on local IP
app.get('/qrcode', async (req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}/phone.html`;
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
  const ip = getLocalIP();
  console.log(`\n✅ Sandbox Testing running!`);
  console.log(`   Desktop → http://localhost:${PORT}`);
  console.log(`   Phone   → http://${ip}:${PORT}/phone.html\n`);
});
