/*
 * Telegram Mini App — Tic-Tac-Toe PvP
 * Node.js 18+, Express + ws.
 *
 * ВАЖНО ПО STARS:
 * 1) Mini App НЕ может самостоятельно списать Stars с пользователя.
 * 2) Для цифровой услуги сервер создаёт Telegram invoice в XTR.
 * 3) Telegram присылает pre_checkout_query, затем successful_payment.
 * 4) Только после successful_payment ставка считается оплаченной.
 * 5) Bot API не предоставляет обычный метод "перевести Stars пользователю".
 *    Поэтому payout ниже является внутренним расчётом приза, а не фальшивым
 *    переводом Stars. Для реального cash-out/выплаты нужен отдельный
 *    поддерживаемый Telegram/бизнес-механизм или внешний регулируемый платёжный
 *    контур, который вы подключите отдельно.
 *
 * Переменные окружения:
 * BOT_TOKEN=123:ABC...
 * PORT=10000                 (Render обычно передаёт PORT автоматически)
 * WEBHOOK_SECRET=любая-длинная-строка
 * WEBHOOK_AUTO_SETUP=true
 * AUTH_MAX_AGE_SEC=86400
 * HOUSE_FEE_PERCENT=10
 */

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";

// --- АВТОМАТИЧЕСКОЕ ОПРЕДЕЛЕНИЕ PUBLIC_URL ---
// Если переменная PUBLIC_URL не задана в Render, код автоматически формирует её на основе имени вашего сервиса
let DEFAULT_URL = "";
if (process.env.RENDER_EXTERNAL_URL) {
  DEFAULT_URL = process.env.RENDER_EXTERNAL_URL;
} else if (process.env.RENDER_SERVICE_NAME) {
  DEFAULT_URL = `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
} else {
  DEFAULT_URL = "https://soska-1.onrender.com"; // Резервный адрес для вашего проекта
}

const PUBLIC_URL = (process.env.PUBLIC_URL || DEFAULT_URL).replace(/\/+$/, "");
// ----------------------------------------------

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const AUTH_MAX_AGE_SEC = Number(process.env.AUTH_MAX_AGE_SEC || 86400);
const HOUSE_FEE_PERCENT = Math.max(
  0,
  Math.min(50, Number(process.env.HOUSE_FEE_PERCENT || 10))
);
const WEBHOOK_AUTO_SETUP = String(process.env.WEBHOOK_AUTO_SETUP || "true").toLowerCase() === "true";

const ALLOWED_STAKES = new Set([5, 10, 50, 100]);
const TURN_SECONDS = 30;
const SEARCH_LIMIT_MS = 5 * 60 * 1000;

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/* --------------------------- ХРАНИЛИЩЕ --------------------------- */
const users = new Map();          // userId -> user
const queues = new Map();         // stake -> [userId]
const rooms = new Map();          // roomId -> room
const socketUsers = new Map();    // ws -> userId
const pendingPayments = new Map();// payload -> payment
const processedCharges = new Set();

function now() {
  return Date.now();
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username || "",
    photoUrl: user.photoUrl || "",
    stats: user.stats,
    wallet: {
      paidInStars: user.wallet.paidInStars,
      pendingPrizeStars: user.wallet.pendingPrizeStars
    }
  };
}

function getOrCreateUser(tgUser) {
  const id = String(tgUser.id);
  let user = users.get(id);

  if (!user) {
    user = {
      id,
      name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || "Игрок",
      username: tgUser.username || "",
      photoUrl: tgUser.photo_url || "",
      stats: { wins: 0, draws: 0, losses: 0 },
      wallet: { paidInStars: 0, pendingPrizeStars: 0 },
      ws: null,
      roomId: null,
      queueStake: null
    };
    users.set(id, user);
  } else {
    user.name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || user.name;
    user.username = tgUser.username || user.username;
    user.photoUrl = tgUser.photo_url || user.photoUrl;
  }
  return user;
}

/* ---------------------- Telegram initData ------------------------- */
function validateInitData(initData) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN не настроен");
  if (!initData || typeof initData !== "string") {
    throw new Error("Отсутствует Telegram initData");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("В initData отсутствует hash");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > AUTH_MAX_AGE_SEC) {
    throw new Error("Telegram initData устарел");
  }

  const dataCheck = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const expected = crypto
    .createHmac("sha256", secret)
    .update(dataCheck)
    .digest("hex");

  if (
    expected.length !== hash.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))
  ) {
    throw new Error("Неверная подпись Telegram initData");
  }

  const userJson = params.get("user");
  if (!userJson) throw new Error("В initData отсутствует user");

  const tgUser = JSON.parse(userJson);
  if (!tgUser.id) throw new Error("Некорректный Telegram user");

  return tgUser;
}

/* ------------------------- WebSocket auth -------------------------- */
function wsSend(ws, type, data = {}) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function userFromWs(ws) {
  const id = socketUsers.get(ws);
  return id ? users.get(id) : null;
}

function broadcastRoom(room, type, data = {}) {
  for (const player of room.players) {
    wsSend(player.user.ws, type, data);
  }
}

/* ------------------------- Telegram API --------------------------- */
async function telegram(method, body) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN не настроен");

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  if (!json.ok) {
    throw new Error(json.description || `Telegram API ${method} failed`);
  }
  return json.result;
}

async function createStakeInvoice(userId, stake) {
  const payload = `stake:${userId}:${stake}:${crypto.randomUUID()}`;

  const result = await telegram("createInvoiceLink", {
    title: "Ставка в Tic-Tac-Toe",
    description: `Участие в PvP матче — ${stake} Telegram Stars`,
    payload,
    currency: "XTR",
    prices: [{ label: "Ставка", amount: stake }],
    subscription_period: undefined
  });

  pendingPayments.set(payload, {
    payload,
    userId: String(userId),
    stake,
    createdAt: now(),
    status: "invoice_created",
    chargeId: null
  });

  return { invoiceUrl: result, payload };
}

/* -------------------------- Очереди -------------------------------- */
function removeFromQueue(userId) {
  const user = users.get(String(userId));
  if (!user || user.queueStake == null) return;

  const stake = user.queueStake;
  const queue = queues.get(stake) || [];
  queues.set(
    stake,
    queue.filter(id => String(id) !== String(userId))
  );
  user.queueStake = null;
}

function enqueue(user, stake) {
  if (!ALLOWED_STAKES.has(stake)) {
    throw new Error("Недопустимая ставка");
  }

  if (user.roomId) throw new Error("Вы уже находитесь в матче");
  if (user.queueStake != null) throw new Error("Вы уже ищете соперника");

  let queue = queues.get(stake);
  if (!queue) {
    queue = [];
    queues.set(stake, queue);
  }

  queue = queue.filter(id => {
    const candidate = users.get(String(id));
    return candidate && candidate.ws && candidate.ws.readyState === 1 && candidate.queueStake === stake;
  });
  queues.set(stake, queue);

  const opponentId = queue.shift();

  if (opponentId) {
    const opponent = users.get(String(opponentId));
    if (
      opponent &&
      opponent.ws &&
      opponent.ws.readyState === 1 &&
      opponent.queueStake === stake
    ) {
      user.queueStake = null;
      opponent.queueStake = null;
      createRoom(user, opponent, stake);
      return;
    }
  }

  queue.push(user.id);
  user.queueStake = stake;

  setTimeout(() => {
    if (user.queueStake === stake && !user.roomId) {
      removeFromQueue(user.id);
      wsSend(user.ws, "search_expired");
    }
  }, SEARCH_LIMIT_MS);
}

/* --------------------------- Игра --------------------------------- */
function createRoom(a, b, stake) {
  const room = {
    id: crypto.randomUUID(),
    stake,
    createdAt: now(),
    players: [
      { user: a, symbol: "X", connected: true, paymentConfirmed: true },
      { user: b, symbol: "O", connected: true, paymentConfirmed: true }
    ],
    board: Array(9).fill(null),
    turn: "X",
    turnStartedAt: now(),
    turnTimer: null,
    ended: false,
    winner: null
  };

  a.roomId = room.id;
  b.roomId = room.id;
  rooms.set(room.id, room);

  broadcastRoom(room, "match_found", {
    roomId: room.id,
    stake,
    board: room.board,
    turn: room.turn,
    players: room.players.map(p => ({
      id: p.user.id,
      name: p.user.name,
      username: p.user.username,
      photoUrl: p.user.photoUrl,
      symbol: p.symbol
    }))
  });

  startTurnTimer(room);
}

function getPlayer(room, userId) {
  return room.players.find(p => p.user.id === String(userId));
}

function checkWinner(board) {
  const lines = [, [3,4,5], [6,7,8],
, [1,4,7], [2,5,8],
, [2,4,6]
  ];

  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }

  return board.every(Boolean) ? "DRAW" : null;
}

function stopTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

