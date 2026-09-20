const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
​const app = express();
const server = http.createServer(app);
const io = new Server(server);
​app.use(express.json());
app.use(express.static(__dirname));
​const BOT_TOKEN = process.env.BOT_TOKEN || '';
​const users = {};
const activeChats = {};
const queue = [];
​app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'index.html'));
});
​// Telegram Stars: Create Invoice Link API
app.post('/api/create-stars-invoice', async (req, res) => {
const { userId, amount, title } = req.body;
​if (!BOT_TOKEN) {
return res.status(400).json({
success: false,
error: 'BOT_TOKEN is not set in Render environment variables'
});
}
​try {
const response = await fetch(https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
title: title || 'Пополнение звёзд',
description: Покупка ${amount} Telegram Stars,
payload: user_${userId}_stars_${amount}_${Date.now()},
currency: 'XTR', // Currency code for Telegram Stars
prices: [{ label: ${amount} Stars, amount: Number(amount) }]
})
});
​const data = await response.json();
if (data.ok) {
res.json({ success: true, invoiceLink: data.result });
} else {
res.status(400).json({ success: false, error: data.description });
}
} catch (err) {
res.status(500).json({ success: false, error: err.message });
}
});
​// Socket.io for Realtime Chat & Game Logic
io.on('connection', (socket) => {
console.log('User connected:', socket.id);
​socket.on('register_user', (data) => {
users[socket.id] = { ...data, socketId: socket.id, stars: 0 };
});
​socket.on('find_partner', () => {
if (queue.length > 0) {
const partnerSocketId = queue.shift();
if (partnerSocketId !== socket.id) {
const roomId = room_${socket.id}_${partnerSocketId};
activeChats[socket.id] = partnerSocketId;
activeChats[partnerSocketId] = socket.id;
​socket.join(roomId);
const partnerSocket = io.sockets.sockets.get(partnerSocketId);
if (partnerSocket) partnerSocket.join(roomId);
​io.to(roomId).emit('chat_start', { roomId });
} else {
queue.push(socket.id);
}
} else {
queue.push(socket.id);
socket.emit('waiting_for_partner');
}
});
​socket.on('send_message', (data) => {
const partnerId = activeChats[socket.id];
if (partnerId) {
io.to(partnerId).emit('receive_message', {
text: data.text,
sender: socket.id
});
}
});
​socket.on('send_gift', (data) => {
const partnerId = activeChats[socket.id];
if (partnerId) {
io.to(partnerId).emit('receive_gift', {
giftName: data.giftName,
stars: data.stars
});
}
});
​socket.on('disconnect', () => {
const index = queue.indexOf(socket.id);
if (index !== -1) queue.splice(index, 1);
​const partnerId = activeChats[socket.id];
if (partnerId) {
io.to(partnerId).emit('partner_disconnected');
delete activeChats[partnerId];
delete activeChats[socket.id];
}
delete users[socket.id];
});
});
​const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
console.log(Server running on port ${PORT});
});
