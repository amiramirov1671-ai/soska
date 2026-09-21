/*
 * Telegram Mini App — Tic-Tac-Toe PvP
 * Node.js 18+, Express + ws.
 *
 * ИСПРАВЛЕНИЯ ОТ ИСХОДНОЙ ВЕРСИИ (кратко, см. комментарии "FIX:" по коду):
 * 1. Ставка теперь реально списывается с баланса при старте матча, и игрок
 *    не может попасть в очередь без оплаченного баланса — раньше платёж
 *    никак не проверялся и не тратился, игра была "бесплатной" по факту.
 * 2. Webhook Telegram теперь проверяет секретный токен (X-Telegram-Bot-Api-
 *    Secret-Token) — раньше кто угодно мог отправить POST на /webhook с
 *    поддельным successful_payment и начислить себе звёзды без оплаты.
 * 3. Статика отдаётся из отдельной папки /public, а не из корня проекта —
 *    раньше express.static(__dirname) отдавал наружу сам server.js,
 *    package.json и т.д.
 * 4. Переподключение: если игрок обновил страницу / потерял связь во время
 *    матча, у него есть 20 секунд на возврат, прежде чем засчитывается
 *    поражение — раньше любой обрыв соединения мгновенно засчитывал проигрыш.
 * 5. Очистка старых записей в pendingPayments / processedCharges, чтобы
 *    память не росла бесконечно.
 */

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";

// --- АВТОМАТИЧЕСКОЕ ОПРЕДЕЛЕНИЕ PUBLIC_URL ---
let DEFAULT_URL = "";
if (process.env.RENDER_EXTERNAL_URL) {
  DEFAULT_URL = process.env.RENDER_EXTERNAL_URL;
} else if (process.env.RENDER_SERVICE_NAME) {
  DEFAULT_URL = `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
} else {
  DEFAULT_URL = "https://soska-1.onrender.com";
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
const RECONNECT_GRACE_MS = 20 * 1000; // FIX: время на переподключение перед техпоражением
const PENDING_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000; // FIX: чистка старых инвойсов

const app = express();
app.use(express.json({ limit: "256kb" }));
// FIX: отдаём статику только из /public, а не из корня проекта с исходниками
app.use(express.static(path.join(__dirname, "public")));

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

function roomStateFor(room) {
  return {
    roomId: room.id,
    stake: room.stake,
    board: room.board,
    turn: room.turn,
    turnStartedAt: room.turnStartedAt,
    turnSeconds: TURN_SECONDS,
    players: room.players.map(p => ({
      id: p.user.id,
      name: p.user.name,
      username: p.user.username,
      photoUrl: p.user.photoUrl,
      symbol: p.symbol,
      connected: p.connected
    }))
  };
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
    prices: [{ label: "Ставка", amount: stake }]
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

  // FIX: раньше в очередь можно было встать без оплаты — баланс никогда
  // не проверялся и не списывался, ставка была чисто декоративной.
  if (user.wallet.paidInStars < stake) {
    throw new Error("Недостаточно средств для этой ставки. Пополните баланс.");
  }

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
      opponent.queueStake === stake &&
      opponent.wallet.paidInStars >= stake // FIX: перепроверяем баланс соперника перед матчем
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
  // FIX: реально списываем ставку у обоих игроков в момент старта матча
  a.wallet.paidInStars -= stake;
  b.wallet.paidInStars -= stake;

  const room = {
    id: crypto.randomUUID(),
    stake,
    createdAt: now(),
    players: [
      { user: a, symbol: "X", connected: true, disconnectTimer: null },
      { user: b, symbol: "O", connected: true, disconnectTimer: null }
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

  broadcastRoom(room, "match_found", roomStateFor(room));
  for (const p of room.players) {
    wsSend(p.user.ws, "wallet_update", { wallet: p.user.wallet });
  }

  startTurnTimer(room);
}

function getPlayer(room, userId) {
  return room.players.find(p => p.user.id === String(userId));
}

function checkWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Горизонтали
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Вертикали
    [0, 4, 8], [2, 4, 6]             // Диагонали
  ];

  for (const [a, b, c] of lines) {
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

function startTurnTimer(room) {
  stopTurnTimer(room);
  room.turnStartedAt = now();

  room.turnTimer = setTimeout(() => {
    if (room.ended) return;

    const loser = room.players.find(p => p.symbol === room.turn);
    const winner = room.players.find(p => p.symbol !== room.turn);

    finishRoom(room, {
      result: "timeout",
      winnerSymbol: winner.symbol,
      loserSymbol: loser.symbol
    });
  }, TURN_SECONDS * 1000);

  broadcastRoom(room, "turn", {
    turn: room.turn,
    turnStartedAt: room.turnStartedAt,
    turnSeconds: TURN_SECONDS
  });
}

function clearDisconnectTimers(room) {
  for (const p of room.players) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }
}

function finishRoom(room, outcome) {
  if (room.ended) return;
  room.ended = true;
  stopTurnTimer(room);
  clearDisconnectTimers(room); // FIX: не оставляем висящие таймеры после завершения

  const winnerPlayer = outcome.winnerSymbol ? room.players.find(p => p.symbol === outcome.winnerSymbol) : null;
  const loserPlayer = outcome.loserSymbol ? room.players.find(p => p.symbol === outcome.loserSymbol) : null;

  const gross = room.stake * 2;
  const fee = Math.floor(gross * HOUSE_FEE_PERCENT / 100);
  const netPrize = gross - fee;

  if (winnerPlayer && loserPlayer) {
    winnerPlayer.user.stats.wins += 1;
    winnerPlayer.user.wallet.pendingPrizeStars += netPrize;

    loserPlayer.user.stats.losses += 1;

    room.winner = winnerPlayer.user.id;
  } else {
    for (const p of room.players) {
      p.user.stats.draws += 1;
      p.user.wallet.pendingPrizeStars += room.stake; // возврат ставки при ничьей
    }
  }

  broadcastRoom(room, "game_over", {
    result: outcome.result,
    winner: room.winner,
    board: room.board,
    players: room.players.map(p => ({
      id: p.user.id,
      stats: p.user.stats,
      wallet: p.user.wallet
    }))
  });

  for (const p of room.players) {
    p.user.roomId = null;
  }

  rooms.delete(room.id);
}

/* -------------------------- HTTP Webhook --------------------------- */
app.post("/webhook", async (req, res) => {
  try {
    // FIX: проверяем секретный токен Telegram, иначе кто угодно может
    // подделать POST на /webhook с фальшивым successful_payment.
    if (WEBHOOK_SECRET) {
      const provided = req.get("x-telegram-bot-api-secret-token") || "";
      const expected = Buffer.from(WEBHOOK_SECRET);
      const given = Buffer.from(provided);
      const valid =
        given.length === expected.length &&
        crypto.timingSafeEqual(given, expected);
      if (!valid) {
        return res.sendStatus(401);
      }
    }

    const update = req.body;

    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;
      await telegram("answerPreCheckoutQuery", {
        pre_checkout_query_id: query.id,
        ok: true
      });
      return res.sendStatus(200);
    }

    if (update.message && update.message.successful_payment) {
      const payment = update.message.successful_payment;
      const payload = payment.invoice_payload;
      const chargeId = payment.telegram_payment_charge_id;

      if (processedCharges.has(chargeId)) {
        return res.sendStatus(200);
      }
      processedCharges.add(chargeId);

      const pending = pendingPayments.get(payload);
      if (pending) {
        pending.status = "paid";
        pending.chargeId = chargeId;

        const user = users.get(pending.userId);
        if (user) {
          user.wallet.paidInStars += pending.stake;
          wsSend(user.ws, "payment_success", { stake: pending.stake, wallet: user.wallet });
        }
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------- REST API ------------------------------- */
app.post("/api/auth", (req, res) => {
  try {
    const { initData } = req.body;
    const tgUser = validateInitData(initData);
    const user = getOrCreateUser(tgUser);

    res.json({ success: true, user: safeUser(user) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/invoice", (req, res) => {
  try {
    const { initData, stake } = req.body;
    const tgUser = validateInitData(initData);
    const user = getOrCreateUser(tgUser);

    const stakeNum = Number(stake);
    if (!ALLOWED_STAKES.has(stakeNum)) {
      return res.status(400).json({ success: false, error: "Недопустимая ставка" });
    }

    // FIX: если баланса уже хватает, не создаём лишний инвойс
    if (user.wallet.paidInStars >= stakeNum) {
      return res.json({ success: true, sufficientBalance: true, wallet: user.wallet });
    }

    createStakeInvoice(user.id, stakeNum).then(result => {
      res.json({ success: true, ...result });
    }).catch(err => {
      res.status(500).json({ success: false, error: err.message });
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/* ----------------------- WebSocket Server -------------------------- */
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  ws.on("message", message => {
    try {
      const data = JSON.parse(message.toString());
      const { type, initData } = data;

      if (type === "auth") {
        const tgUser = validateInitData(initData);
        const user = getOrCreateUser(tgUser);

        if (user.ws && user.ws !== ws && user.ws.readyState === 1) {
          wsSend(user.ws, "auth_conflict", { message: "Сессия открыта в другом окне" });
          user.ws.close();
        }

        user.ws = ws;
        socketUsers.set(ws, user.id);

        wsSend(ws, "auth_ok", { user: safeUser(user) });

        // FIX: восстановление состояния при переподключении — раньше
        // обновление страницы во время матча или поиска "теряло" игрока.
        if (user.roomId) {
          const room = rooms.get(user.roomId);
          if (room && !room.ended) {
            const player = getPlayer(room, user.id);
            if (player) {
              player.connected = true;
              if (player.disconnectTimer) {
                clearTimeout(player.disconnectTimer);
                player.disconnectTimer = null;
                const opponent = room.players.find(p => p.user.id !== user.id);
                wsSend(opponent.user.ws, "opponent_reconnected", {});
              }
              wsSend(ws, "match_found", roomStateFor(room));
            }
          } else {
            user.roomId = null;
          }
        } else if (user.queueStake != null) {
          wsSend(ws, "searching", { stake: user.queueStake });
        }
        return;
      }

      const user = userFromWs(ws);
      if (!user) {
        return wsSend(ws, "error", { message: "Требуется авторизация" });
      }

      if (type === "find_match") {
        const stake = Number(data.stake);
        enqueue(user, stake);
        wsSend(ws, "searching", { stake });
      } else if (type === "cancel_search") {
        removeFromQueue(user.id);
        wsSend(ws, "search_cancelled");
      } else if (type === "make_move") {
        const room = rooms.get(user.roomId);
        if (!room || room.ended) return wsSend(ws, "error", { message: "Матч не найден" });

        const player = getPlayer(room, user.id);
        if (!player || player.symbol !== room.turn) {
          return wsSend(ws, "error", { message: "Сейчас не ваш ход" });
        }

        const index = Number(data.index);
        if (isNaN(index) || index < 0 || index > 8 || room.board[index]) {
          return wsSend(ws, "error", { message: "Неверный ход" });
        }

        room.board[index] = player.symbol;
        broadcastRoom(room, "move", { index, symbol: player.symbol, board: room.board });

        const winnerSymbol = checkWinner(room.board);
        if (winnerSymbol) {
          if (winnerSymbol === "DRAW") {
            finishRoom(room, { result: "draw" });
          } else {
            const winner = room.players.find(p => p.symbol === winnerSymbol);
            const loser = room.players.find(p => p.symbol !== winnerSymbol);
            finishRoom(room, { result: "win", winnerSymbol: winner.symbol, loserSymbol: loser.symbol });
          }
        } else {
          room.turn = room.turn === "X" ? "O" : "X";
          startTurnTimer(room);
        }
      }
    } catch (err) {
      wsSend(ws, "error", { message: err.message });
    }
  });

  ws.on("close", () => {
    const user = userFromWs(ws);
    if (user) {
      removeFromQueue(user.id);

      if (user.roomId) {
        const room = rooms.get(user.roomId);
        if (room && !room.ended) {
          const player = getPlayer(room, user.id);
          const opponentPlayer = room.players.find(p => p.user.id !== user.id);

          if (player) {
            player.connected = false;
            wsSend(opponentPlayer && opponentPlayer.user.ws, "opponent_disconnected", {
              graceSeconds: RECONNECT_GRACE_MS / 1000
            });

            // FIX: даём игроку время вернуться, вместо мгновенного техпоражения
            player.disconnectTimer = setTimeout(() => {
              if (room.ended) return;
              finishRoom(room, {
                result: "disconnect",
                winnerSymbol: opponentPlayer.symbol,
                loserSymbol: player.symbol
              });
            }, RECONNECT_GRACE_MS);
          }
        }
      }

      socketUsers.delete(ws);
      if (user.ws === ws) user.ws = null;
    }
  });
});

/* ------------------------- Фоновая очистка -------------------------- */
// FIX: без этого pendingPayments и processedCharges растут бесконечно
setInterval(() => {
  const cutoff = now() - PENDING_PAYMENT_TTL_MS;
  for (const [payload, payment] of pendingPayments) {
    if (payment.createdAt < cutoff) {
      pendingPayments.delete(payload);
    }
  }
  // processedCharges не хранит временную метку — ограничиваем размер набора
  if (processedCharges.size > 50000) {
    processedCharges.clear();
  }
}, 60 * 60 * 1000).unref();

/* ----------------------- Запуск сервера --------------------------- */
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`PUBLIC_URL: ${PUBLIC_URL}`);

  if (WEBHOOK_AUTO_SETUP && BOT_TOKEN && PUBLIC_URL) {
    try {
      const webhookUrl = `${PUBLIC_URL}/webhook`;
      const params = { url: webhookUrl };
      if (WEBHOOK_SECRET) params.secret_token = WEBHOOK_SECRET; // FIX: включаем secret_token в setWebhook
      await telegram("setWebhook", params);
      console.log(`Telegram webhook successfully set to: ${webhookUrl}`);
      if (!WEBHOOK_SECRET) {
        console.warn("WARNING: WEBHOOK_SECRET не задан — установите его, иначе /webhook не защищён от подделки платежей.");
      }
    } catch (err) {
      console.error("Failed to setup Telegram webhook automatically:", err.message);
    }
  }
});
