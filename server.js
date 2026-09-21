const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

// =========================================================================
// 1. НАСТРОЙКА: ВСТАВЬТЕ СЮДА ВАШ ТОКЕН ИЗ BOTFATHER МЕЖДУ ОДИНАРНЫМИ КАВЫЧКАМИ
const BOT_TOKEN = '8952416846:AAHq94RzNvFb7uZVacvrr1Y8jOUD7Q3gLCU'; 
// =========================================================================

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

// Разрешаем запросы со всех адресов, чтобы Telegram Mini App не блокировался
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const bot = new TelegramBot(BOT_TOKEN);

// Настройка правильного вебхука для Render
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://onrender.com';
bot.setWebHook(`${RENDER_EXTERNAL_URL}/bot${BOT_TOKEN}`).catch(err => console.log("Ошибка вебхука:", err));

// Обработчик вебхука Telegram
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// КРАСИВЫЙ НЕОНОВЫЙ ФРОНТЕНД (ОТДАЕТСЯ НАПРЯМУЮ С СЕРВЕРА)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Neon Stars TicTacToe</title>
    <script src="https://telegram.org"></script>
    <style>
        :root {
            --bg-color: #0a0a12;
            --neon-pink: #ff007f;
            --neon-cyan: #00f3ff;
            --neon-purple: #9d00ff;
            --text-color: #ffffff;
        }
        body {
            margin: 0; padding: 0; background-color: var(--bg-color); color: var(--text-color);
            font-family: 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column;
            align-items: center; justify-content: space-between; min-height: 100vh; box-sizing: border-box; overflow: hidden;
        }
        .header {
            width: 100%; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center;
            box-sizing: border-box; background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid rgba(0, 243, 255, 0.2);
            box-shadow: 0 0 15px rgba(0, 243, 255, 0.1);
        }
        .user-info { display: flex; align-items: center; gap: 10px; }
        .username { font-weight: bold; text-shadow: 0 0 5px var(--neon-cyan); }
        .balance-container {
            display: flex; align-items: center; gap: 5px; background: rgba(255, 0, 127, 0.1);
            padding: 5px 12px; border-radius: 20px; border: 1px solid var(--neon-pink); box-shadow: 0 0 10px rgba(255, 0, 127, 0.2);
        }
        .star-icon { color: #ffca28; font-size: 18px; }
        .main-container {
            flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
            width: 100%; max-width: 400px; padding: 20px; box-sizing: border-box; gap: 25px;
        }
        .status-text { font-size: 18px; text-align: center; min-height: 24px; text-shadow: 0 0 8px var(--text-color); }
        .board {
            display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); gap: 10px;
            width: 90vw; height: 90vw; max-width: 320px; max-height: 320px; background: rgba(157, 0, 255, 0.05);
            border-radius: 15px; padding: 10px; border: 2px solid var(--neon-purple); box-shadow: 0 0 20px rgba(157, 0, 255, 0.3);
        }
        .cell {
            background: rgba(10, 10, 18, 0.8); border-radius: 8px; display: flex; align-items: center;
            justify-content: center; font-size: 48px; font-weight: 900; cursor: pointer; transition: all 0.2s ease;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .cell:active { transform: scale(0.95); }
        .cell.x { color: var(--neon-cyan); text-shadow: 0 0 15px var(--neon-cyan); }
        .cell.o { color: var(--neon-pink); text-shadow: 0 0 15px var(--neon-pink); }
        .actions { width: 100%; display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
        .btn {
            background: transparent; color: white; border: 2px solid var(--neon-cyan); padding: 14px;
            font-size: 16px; font-weight: bold; border-radius: 12px; cursor: pointer; transition: all 0.3s ease;
            text-transform: uppercase; letter-spacing: 1px; box-shadow: 0 0 10px rgba(0, 243, 255, 0.1);
        }
        .btn:active { transform: scale(0.98); }
        .btn-search { border-color: var(--neon-cyan); box-shadow: 0 0 15px rgba(0, 243, 255, 0.2); }
        .btn-search:hover { background: var(--neon-cyan); color: black; box-shadow: 0 0 25px var(--neon-cyan); }
        .btn-stars { border-color: var(--neon-pink); box-shadow: 0 0 15px rgba(255, 0, 127, 0.2); }
        .btn-stars:hover { background: var(--neon-pink); box-shadow: 0 0 25px var(--neon-pink); }
        .disabled { opacity: 0.5; pointer-events: none; }
    </style>
</head>
<body>

    <div class="header">
        <div class="user-info">
            <span class="username" id="username">Игрок</span>
        </div>
        <div class="balance-container">
            <span class="star-icon">⭐</span>
            <span id="balance">0</span>
        </div>
    </div>

    <div class="main-container">
        <div class="status-text" id="status">Подключение к серверу...</div>

        <div class="board disabled" id="board">
            <div class="cell" data-index="0"></div>
            <div class="cell" data-index="1"></div>
            <div class="cell" data-index="2"></div>
            <div class="cell" data-index="3"></div>
            <div class="cell" data-index="4"></div>
            <div class="cell" data-index="5"></div>
            <div class="cell" data-index="6"></div>
            <div class="cell" data-index="7"></div>
            <div class="cell" data-index="8"></div>
        </div>

        <div class="actions">
            <button class="btn btn-search disabled" id="searchBtn">Искать PvP (Ставка: 5 ⭐)</button>
            <button class="btn btn-stars" id="buyBtn">Пополнить Звезды</button>
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();

        const userId = tg.initDataUnsafe?.user?.id || Math.floor(Math.random() * 100000);
        const name = tg.initDataUnsafe?.user?.first_name || "Аноним";
        document.getElementById('username').innerText = name;

        let ws;
        let mySymbol = null;
        let isMyTurn = false;

        // Автоматически подключаемся по правильному адресу Render
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = wsProtocol + '//' + window.location.host;

        function connectWS() {
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                document.getElementById('status').innerText = "Успешно подключено! Ищите PvP";
                document.getElementById('searchBtn').classList.remove('disabled');
                ws.send(JSON.stringify({ type: 'auth', userId, name }));
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                switch(data.type) {
                    case 'userData':
                        document.getElementById('balance').innerText = data.balance;
                        break;
                    case 'waiting':
                        document.getElementById('status').innerText = "Поиск оппонента в сети...";
                        document.getElementById('searchBtn').classList.add('disabled');
                        break;
                    case 'gameStart':
                        mySymbol = data.symbol;
                        isMyTurn = (mySymbol === 'X');
                        document.getElementById('board').classList.remove('disabled');
                        document.getElementById('searchBtn').classList.add('disabled');
                        resetBoardVisuals();
                        updateStatusText();
                        break;
                    case 'update':
                        document.querySelectorAll('.cell')[data.index].innerText = data.symbol;
                        document.querySelectorAll('.cell')[data.index].classList.add(data.symbol.toLowerCase());
                        isMyTurn = (data.nextTurn === mySymbol);
                        updateStatusText();
                        break;
                    case 'gameOver':
                        document.getElementById('board').classList.add('disabled');
                        document.getElementById('searchBtn').classList.remove('disabled');
                        document.getElementById('status').innerText = data.winner === 'draw' ? "Ничья! Ставки возвращены." : (data.winner === mySymbol ? "🎉 Вы победили!" : "😢 Вы проиграли.");
                        ws.send(JSON.stringify({ type: 'get_balance', userId }));
                        break;
                    case 'opponentLeft':
                        document.getElementById('board').classList.add('disabled');
                        document.getElementById('searchBtn').classList.remove('disabled');
                        document.getElementById('status').innerText = "Соперник сбежал. Победили вы!";
                        ws.send(JSON.stringify({ type: 'get_balance', userId }));
                        break;
                    case 'error':
                        tg.showAlert(data.message);
                        document.getElementById('searchBtn').classList.remove('disabled');
                        break;
                }
