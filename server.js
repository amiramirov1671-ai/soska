const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// === АВТОМАТИЧЕСКИЙ ДЕПЛОЙ ДЛЯ RENDER ===
const PORT = process.env.PORT || 3000;
// Код ниже автоматически пробует найти токен в вашем Render по популярным названиям:
const BOT_TOKEN = '8952416846:AAHq94RzNvFb7uZVacvrr1Y8jOUD7Q3gLCU';


if (!BOT_TOKEN) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: Токен бота не найден в переменных окружения Render!");
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
// Автоматически определяем адрес вашего Render сервера
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const bot = new TelegramBot(BOT_TOKEN);

if (RENDER_EXTERNAL_URL) {
    bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${BOT_TOKEN}`);
    console.log(`Вебхук успешно установлен на адрес: ${RENDER_EXTERNAL_URL}`);
} else {
    console.log("Локальный запуск, вебхук не установлен");
}

// Эндпоинт для приема сообщений от Telegram через вебхук
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});


// Имитация базы данных пользователей (в продакшене лучше использовать БД)
const usersDb = {}; 
let matchmakingQueue = null; // Очередь для поиска игры (содержит userId одного игрока)
const activeGames = {}; // Хранилище запущенных матчей

// Получение или создание профиля пользователя
function getUser(userId, name = "Игрок") {
    if (!usersDb[userId]) {
        usersDb[userId] = { userId, name, balance: 10, ws: null }; // Даем 10 приветственных звезд
    }
    return usersDb[userId];
}

// Эндпоинт для генерации счета на покупку Звезд
app.post('/create-stars-invoice', async (req, res) => {
    const { userId } = req.body;
    try {
        // Создаем инвойс на 10 звезд внутри Телеграм [1.1]
        const invoiceLink = await bot.createInvoiceLink(
            "Пополнение игрового баланса",
            "10 Звезд для игры в Крестики-Нолики",
            "stars_topup_" + userId,
            "", // Провайдер пустой для Telegram Stars [1.1]
            "XTR", // Код валюты для Telegram Stars строго XTR [1.1]
            [{ label: "10 Звезд", amount: 10 }]
        );
        res.json({ invoiceLink });
    } catch (err) {
        res.status(500).json({ error: "Ошибка создания инвойса" });
    }
});

// Обработка успешного платежа в Telegram-боте [1.1]
bot.on('pre_checkout_query', (query) => {
    bot.answerPreCheckoutQuery(query.id, true);
});

bot.on('successful_payment', (msg) => {
    const payload = msg.successful_payment.invoice_payload;
    if (payload.startsWith("stars_topup_")) {
        const userId = payload.split("_");
        const user = getUser(userId);
        user.balance += 10; // Добавляем купленные 10 звезд
        if (user.ws) {
            user.ws.send(JSON.stringify({ type: 'userData', balance: user.balance }));
        }
    }
});

// Логика проверки победы в игре
function checkWinner(board) {
    const lines = [, [3, 4, 5], [6, 7, 8], // Горизонтали, [1, 4, 7], [2, 5, 8], // Вертикали, [2, 4, 6]             // Диагонали
    ];
    for (let line of lines) {
        const [a, b, c] = line;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a];
        }
    }
    if (board.every(cell => cell !== null)) return 'draw';
    return null;
}

// Работа по WebSockets
wss.on('connection', (ws) => {
    let currentUserId = null;

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        if (data.type === 'auth') {
            currentUserId = data.userId;
            const user = getUser(data.userId, data.name);
            user.ws = ws;
            ws.send(JSON.stringify({ type: 'userData', balance: user.balance }));
        }

        if (data.type === 'get_balance') {
            const user = getUser(data.userId);
            ws.send(JSON.stringify({ type: 'userData', balance: user.balance }));
        }

        if (data.type === 'search_game') {
            const user = getUser(data.userId);
            const STAKE = 5; // Ставка на игру

            if (user.balance < STAKE) {
                ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно Звезд для ставки! Нужно 5 ⭐.' }));
                return;
            }

            // Если игрок уже в очереди, ничего не делаем
            if (matchmakingQueue === user.userId) return;

            // Если есть кто-то в очереди — запускаем матч
            if (matchmakingQueue && matchmakingQueue !== user.userId) {
                const opponentId = matchmakingQueue;
                const opponent = getUser(opponentId);
                matchmakingQueue = null;

                // Списываем ставки с обоих
                user.balance -= STAKE;
                opponent.balance -= STAKE;

                const gameId = `game_${user.userId}_${opponentId}`;
                activeGames[gameId] = {
                    players: { X: opponentId, O: user.userId },
                    board: Array(9).fill(null),
                    turn: 'X'
                };

                user.gameId = gameId;
                opponent.gameId = gameId;

                // Отправляем сигналы о старте матча
                opponent.ws.send(JSON.stringify({ type: 'gameStart', symbol: 'X', opponentName: user.name }));
                user.ws.send(JSON.stringify({ type: 'gameStart', symbol: 'O', opponentName: opponent.name }));
            } else {
                // Если очередь пуста, встаем в нее
                matchmakingQueue = user.userId;
                ws.send(JSON.stringify({ type: 'waiting' }));
            }
        }

        if (data.type === 'make_move') {
            const user = getUser(data.userId);
            const game = activeGames[user.gameId];
            if (!game) return;

            const playerSymbol = game.players.X === user.userId ? 'X' : 'O';
            if (game.turn !== playerSymbol || game.board[data.index] !== null) return;

            // Делаем ход
            game.board[data.index] = playerSymbol;
            game.turn = game.turn === 'X' ? 'O' : 'X';

            const p1 = getUser(game.players.X);
            const p2 = getUser(game.players.O);

            const msgUpdate = JSON.stringify({ type: 'update', index: data.index, symbol: playerSymbol, nextTurn: game.turn });
            if (p1.ws) p1.ws.send(msgUpdate);
            if (p2.ws) p2.ws.send(msgUpdate);

            // Проверяем окончание игры
            const winner = checkWinner(game.board);
            if (winner) {
                if (winner === 'draw') {
                    // При ничьей возвращаем ставки (по 5 звезд)
                    p1.balance += 5;
                    p2.balance += 5;
                } else {
                    // Победитель забирает банк (10 звезд за вычетом комиссии 1 звезда серверу)
                    const winnerId = game.players[winner];
                    getUser(winnerId).balance += 9; 
                }

                const msgOver = JSON.stringify({ type: 'gameOver', winner });
                if (p1.ws) p1.ws.send(msgOver);
                if (p2.ws) p2.ws.send(msgOver);

                delete activeGames[user.gameId];
            }
        }
    });

    ws.on('close', () => {
        if (matchmakingQueue === currentUserId) matchmakingQueue = null;
        const user = getUser(currentUserId);
        if (user && user.gameId && activeGames[user.gameId]) {
            const game = activeGames[user.gameId];
            const opponentId = game.players.X === currentUserId ? game.players.O : game.players.X;
            const opponent = getUser(opponentId);
            
            // Если игрок ливнул во время матча, оппонент побеждает и забирает банк
            opponent.balance += 9;
            if (opponent.ws) opponent.ws.send(JSON.stringify({ type: 'opponentLeft' }));
            
            delete activeGames[user.gameId];
        }
    });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
