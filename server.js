const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// Токен бота Telegram из переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN";

// База данных в памяти (для демонстрации и тестирования)
const users = {};
const waitingQueue = {};
const activeGames = {};

// Выигрышные комбинации в крестиках-ноликах
const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

// ==========================================
// 1. Создание счета для покупки Telegram Stars
// ==========================================
app.post('/create-stars-invoice', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Пополнение ${amount} Stars`,
        description: `Пополнение баланса в X-O Cash League`,
        payload: `topup_${userId}_${Date.now()}`,
        currency: "XTR", // Код валюты Telegram Stars
        provider_token: "", // Для Stars передается пустая строка
        prices: [{ label: `${amount} Stars`, amount: Number(amount) }]
      })
    });
    const data = await response.json();
    if (data.ok) {
      res.json({ invoiceUrl: data.result });
    } else {
      res.status(400).json({ error: data.description });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. Webhook для приема уведомлений от Telegram Stars
// ==========================================
app.post('/telegram-webhook', async (req, res) => {
  const update = req.body;

  // Telegram запрашивает подтверждение перед списанием
  if (update.pre_checkout_query) {
    const queryId = update.pre_checkout_query.id;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: queryId, ok: true })
    });
    return res.sendStatus(200);
  }

  // Уведомление об успешной оплате
  if (update.message && update.message.successful_payment) {
    const payment = update.message.successful_payment;
    const userId = update.message.from.id;
    const starsReceived = payment.total_amount;

    if (!users[userId]) users[userId] = { balance: 0 };
    users[userId].balance += starsReceived;

    console.log(`[STARS] Пользователь ${userId} пополнил баланс на +${starsReceived} Stars`);
    
    // Мгновенное обновление баланса в клиенте через WebSocket
    io.to(`user_${userId}`).emit('balance_updated', { balance: users[userId].balance });
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ==========================================
// 3. Логика Мультиплеера (WebSockets)
// ==========================================
io.on('connection', (socket) => {
  let currentUserId = null;

  // Авторизация пользователя при подключении
  socket.on('auth', ({ userId }) => {
    currentUserId = userId;
    socket.join(`user_${userId}`);
    
    if (!users[userId]) {
      users[userId] = { balance: 100 }; // Стартовый бонус
    }
    
    socket.emit('init_data', { balance: users[userId].balance });
  });

  // Поиск матча по выбранной ставке
  socket.on('find_match', ({ stake }) => {
    if (!currentUserId || !users[currentUserId]) return;

    if (users[currentUserId].balance < stake) {
      return socket.emit('error_msg', 'Недостаточно Stars на балансе!');
    }

    if (!waitingQueue[stake]) waitingQueue[stake] = [];

    // Если есть соперник с такой же ставкой
    if (waitingQueue[stake].length > 0) {
      const opponent = waitingQueue[stake].shift();

      if (opponent.userId === currentUserId) {
        waitingQueue[stake].push(opponent);
        return;
      }

      // Списываем ставки с обоих игроков
      users[currentUserId].balance -= stake;
      users[opponent.userId].balance -= stake;

      const totalPot = stake * 2;
      const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

      const game = {
        id: gameId,
        stake: stake,
        pot: totalPot,
        board: Array(9).fill(''),
        players: {
          X: { socketId: socket.id, userId: currentUserId },
          O: { socketId: opponent.socketId, userId: opponent.userId }
        },
        turn: 'X'
      };

      activeGames[gameId] = game;

      socket.join(gameId);
      io.sockets.sockets.get(opponent.socketId)?.join(gameId);

      // Уведомляем игроков о начале игры
      io.to(gameId).emit('match_found', {
        gameId,
        pot: totalPot,
        stake,
        players: { X: currentUserId, O: opponent.userId },
        yourSymbol: socket.id === game.players.X.socketId ? 'X' : 'O'
      });

      io.to(`user_${currentUserId}`).emit('balance_updated', { balance: users[currentUserId].balance });
      io.to(`user_${opponent.userId}`).emit('balance_updated', { balance: users[opponent.userId].balance });

    } else {
      // Помещаем игрока в очередь ожидания
      waitingQueue[stake].push({ socketId: socket.id, userId: currentUserId });
      socket.emit('waiting_for_opponent');
    }
  });

  // Обработка хода
  socket.on('make_move', ({ gameId, cellIndex }) => {
    const game = activeGames[gameId];
    if (!game) return;

    const symbol = game.players.X.socketId === socket.id ? 'X' : 'O';

    if (game.turn !== symbol || game.board[cellIndex] !== '') {
      return;
    }

    game.board[cellIndex] = symbol;
    game.turn = symbol === 'X' ? 'O' : 'X';

    io.to(gameId).emit('board_updated', { board: game.board, turn: game.turn });

    // Проверка победы
    if (checkWin(game.board, symbol)) {
      const winnerUserId = game.players[symbol].userId;
      const fee = Math.floor(game.pot * 0.10); // 10% комиссия сервиса
      const netWin = game.pot - fee;

      users[winnerUserId].balance += netWin;

      io.to(gameId).emit('game_over', {
        winner: symbol,
        winnerUserId,
        fee,
        payout: netWin
      });

      io.to(`user_${winnerUserId}`).emit('balance_updated', { balance: users[winnerUserId].balance });
      delete activeGames[gameId];

    } else if (game.board.every(cell => cell !== '')) {
      // Ничья — возврат ставок
      users[game.players.X.userId].balance += game.stake;
      users[game.players.O.userId].balance += game.stake;

      io.to(gameId).emit('game_over', { winner: 'draw' });

      io.to(`user_${game.players.X.userId}`).emit('balance_updated', { balance: users[game.players.X.userId].balance });
      io.to(`user_${game.players.O.userId}`).emit('balance_updated', { balance: users[game.players.O.userId].balance });
      delete activeGames[gameId];
    }
  });

  socket.on('disconnect', () => {
    Object.keys(waitingQueue).forEach(stake => {
      waitingQueue[stake] = waitingQueue[stake].filter(p => p.socketId !== socket.id);
    });
  });
});

function checkWin(board, symbol) {
  return WINNING_COMBOS.some(combo => combo.every(idx => board[idx] === symbol));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Game Server running on port ${PORT}`);
});
