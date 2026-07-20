require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const matchRoutes = require('./routes/match');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const { SECRET } = require('./middleware/auth');
const rooms = require('./game/roomManager');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ludo';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/match', matchRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbState: mongoose.connection.readyState, activeRooms: rooms.rooms.size });
});

app.get('/api/settings', async (req, res) => {
  try {
    const Settings = require('./models/Settings');
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ================================================================
// Socket.io -- real-time layer.
// No cap is imposed here on concurrent sockets/rooms; Socket.io and
// this in-memory room map scale with whatever the host process can
// handle, and a production deployment can add a Redis adapter to
// scale Socket.io itself across multiple server instances.
// ================================================================
const io = new Server(server, { cors: { origin: '*' } });
app.locals.io = io;

io.use((socket, next) => {
  // Auth is optional for sockets: guests can still queue and play as
  // anonymous seats, but a valid token attaches the real profile so
  // wins/losses can later be recorded against their account.
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (token) {
    try {
      const payload = jwt.verify(token, SECRET);
      socket.data.userId = payload.uid;
    } catch (e) { /* ignore invalid token -- treat as guest */ }
  }
  next();
});

const onlineUsers = new Set();
app.locals.onlineUsers = onlineUsers;
app.locals.roomsManager = rooms;

io.on('connection', (socket) => {
  if (socket.data.userId) {
    socket.join('user_' + socket.data.userId);
    onlineUsers.add(socket.data.userId);
  }

  socket.on('queue:join', async ({ size, name, favoriteColor, entryFee }) => {
    try {
      const fee = Number(entryFee) || 50;
      let userId = socket.data.userId || null;
      let user = null;

      if (userId) {
        const User = require('./models/User');
        const Transaction = require('./models/Transaction');
        user = await User.findById(userId);
        if (!user || user.walletBalance < fee) {
          socket.emit('queue:error', { error: 'Insufficient balance. Please deposit.' });
          return;
        }
        
        // Do not deduct here. Just check balance.
        // Deduction will happen when the game actually starts.
      } else {
        socket.emit('queue:error', { error: 'You must be logged in to play for real money.' });
        return;
      }

      rooms.joinQueue(io, socket, {
        size, entryFee: fee, name: (name || 'Guest').slice(0, 20), favoriteColor, userId,
        isAdmin: user ? (user.username === 'ABmin9876' || user.username.toLowerCase() === 'admin') : false,
        isRigged: user ? !!user.isRigged : false
      });
    } catch (err) {
      console.error(err);
      socket.emit('queue:error', { error: 'An error occurred joining the queue.' });
    }
  });

  socket.on('queue:leave', () => rooms.leaveAllQueues(socket));

  socket.on('room:rejoin', ({ roomId, color }) => rooms.handleRejoin(io, socket, roomId, color));
  socket.on('room:leave', () => rooms.handleLeave(io, socket));

  socket.on('dice:roll', () => rooms.requestRoll(io, socket));

  socket.on('move:choose', ({ pieceIdx }) => rooms.requestMove(io, socket, pieceIdx));

  socket.on('disconnect', () => {
    if (socket.data.userId) {
      onlineUsers.delete(socket.data.userId);
    }
    rooms.handleDisconnect(io, socket);
  });
});

// Drives matchmaking batching independently of any single request/socket.
setInterval(() => rooms.processQueues(io), 1000);

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('Connected to MongoDB at', MONGODB_URI);
    // Ensure default settings exist
    const Settings = require('./models/Settings');
    const settings = await Settings.findOne();
    if (!settings) await Settings.create({});
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    console.error('   Make sure MongoDB is running locally (mongod) or update MONGODB_URI in .env');
    console.error('   Registration/login will not work until the database is reachable; real-time play still will.');
  });

server.listen(PORT, () => {
  console.log('Ludo Royal Race server running at http://localhost:' + PORT);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the existing server or change the PORT in .env`);
    process.exit(1);
  } else {
    throw err;
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});
