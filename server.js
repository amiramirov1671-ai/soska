const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

const BOT_TOKEN = process.env.BOT_TOKEN || '';

const users = {};
const activeChats = {};
const queue = [];

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/telegram', (req, res) => {
  const { initData, userData } = req.body;
  if (userData) {
    users[userData.id] = userData;
    return res.json({ status: 'ok', user: userData });
  }
  res.json({ status: 'connected', botConfigured: Boolean(BOT_TOKEN) });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register_user', (data) => {
    users[socket.id] = { ...data, socketId: socket.id };
  });

  socket.on('find_partner', () => {
    if (queue.length > 0) {
      const partnerSocketId = queue.shift();
      if (partnerSocketId !== socket.id) {
        const roomId = `room_${socket.id}_${partnerSocketId}`;
        activeChats[socket.id] = partnerSocketId;
        activeChats[partnerSocketId] = socket.id;

        socket.join(roomId);
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) partnerSocket.join(roomId);

        io.to(roomId).emit('chat_start', { roomId });
      } else {
        queue.push(socket.id);
      }
    } else {
      queue.push(socket.id);
      socket.emit('waiting_for_partner');
    }
  });

  socket.on('send_message', (data) => {
    const partnerId = activeChats[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('receive_message', {
        text: data.text,
        sender: socket.id
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const index = queue.indexOf(socket.id);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    const partnerId = activeChats[socket.id];
    if (partnerId) {
      io.to(partnerId).emit('partner_disconnected');
      delete activeChats[partnerId];
      delete activeChats[socket.id];
    }
    delete users[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
