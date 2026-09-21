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
 * PUBLIC_URL=https://your-service.onrender.com
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
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
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
/*
 * Это in-memory storage для простого запуска без БД.
 * Для продакшена замените users/stats/payments на PostgreSQL/Redis.
 */
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

/*
 * Создаёт invoice-link для ставки.
 * Пользователь должен подтвердить оплату в Telegram.
 */
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

  /* Убираем "мертвые" ID из очереди. */
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
      {
        user: a,
        symbol: "X",
        connected: true,
        paymentConfirmed: true
      },
      {
        user: b,
        symbol: "O",
        connected: true,
        paymentConfirmed: true
      }
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
  const lines = [
    [0,1,2], [3,4,5], [6,7,8],
    [0,3,6], [1,4,7], [2,5,8],
    [0,4,8], [2,4,6]
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

function finishRoom(room, outcome) {
  if (room.ended) return;
  room.ended = true;
  stopTurnTimer(room);

  const winnerPlayer = outcome.winnerSymbol
    ? room.players.find(p => p.symbol === outcome.winnerSymbol)
    : null;

  const loserPlayer = outcome.loserSymbol
    ? room.players.find(p => p.symbol === outcome.loserSymbol)
    : null;

  const gross = room.stake * 2;
  const fee = Math.floor(gross * HOUSE_FEE_PERCENT / 100);
  const prize = gross - fee;

  if (outcome.result === "draw") {
    room.players.forEach(p => p.user.stats.draws++);
  } else {
    winnerPlayer.user.stats.wins++;
    loserPlayer.user.stats.losses++;

    /*
     * Это внутренний ledger, а НЕ перевод Stars пользователю.
     * Telegram Bot API не даёт универсального transferStars(userId, amount).
     */
    winnerPlayer.user.wallet.pendingPrizeStars += prize;
  }

  const resultPayload = {
    result: outcome.result,
    winnerId: winnerPlayer ? winnerPlayer.user.id : null,
    loserId: loserPlayer ? loserPlayer.user.id : null,
    prizeStars: outcome.result === "draw" ? room.stake : prize,
    grossStars: gross,
    houseFeeStars: outcome.result === "draw" ? 0 : fee,
    feePercent: HOUSE_FEE_PERCENT,
    board: room.board
  };

  broadcastRoom(room, "game_over", resultPayload);

  for (const p of room.players) {
    p.user.roomId = null;
  }

  setTimeout(() => rooms.delete(room.id), 30_000);
}

function makeMove(user, index) {
  const room = rooms.get(user.roomId);
  if (!room || room.ended) throw new Error("Матч не найден");

  const player = getPlayer(room, user.id);
  if (!player) throw new Error("Игрок не найден в этой комнате");

  if (player.symbol !== room.turn) throw new Error("Сейчас ход соперника");

  if (!Number.isInteger(index) || index < 0 || index > 8) {
    throw new Error("Некорректная клетка");
  }

  if (room.board[index]) throw new Error("Клетка уже занята");

  room.board[index] = player.symbol;

  const winner = checkWinner(room.board);

  if (winner === "X" || winner === "O") {
    room.winner = winner;
    broadcastRoom(room, "board", {
      board: room.board,
      lastMove: index,
      symbol: player.symbol
    });

    finishRoom(room, {
      result: "win",
      winnerSymbol: winner,
      loserSymbol: winner === "X" ? "O" : "X"
    });
    return;
  }

  if (winner === "DRAW") {
    broadcastRoom(room, "board", {
      board: room.board,
      lastMove: index,
      symbol: player.symbol
    });

    finishRoom(room, { result: "draw" });
    return;
  }

  room.turn = room.turn === "X" ? "O" : "X";

  broadcastRoom(room, "board", {
    board: room.board,
    lastMove: index,
    symbol: player.symbol
  });

  startTurnTimer(room);
}

function resign(user) {
  const room = rooms.get(user.roomId);
  if (!room || room.ended) return;

  const player = getPlayer(room, user.id);
  if (!player) return;

  const winner = room.players.find(p => p.user.id !== user.id);
  finishRoom(room, {
    result: "resign",
    winnerSymbol: winner.symbol,
    loserSymbol: player.symbol
  });
}


/*
 * Автоматическая установка Telegram webhook при старте Render.
 * BOT_TOKEN берётся ТОЛЬКО из Environment Variables Render.
 */
async function setupTelegramWebhook() {
  if (!BOT_TOKEN || !PUBLIC_URL || !WEBHOOK_AUTO_SETUP) return;

  try {
    const webhookUrl = `${PUBLIC_URL}/telegram/webhook`;
    const result = await telegram("setWebhook", {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET || undefined,
      allowed_updates: ["message", "pre_checkout_query"]
    });

    console.log("Telegram webhook configured:", webhookUrl, result);
  } catch (error) {
    console.error("Telegram webhook setup failed:", error.message);
  }
}

/* ------------------------ HTTP API -------------------------------- */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    queues: [...queues.entries()].reduce((sum, [, q]) => sum + q.length, 0)
  });
});

app.post("/api/session", (req, res) => {
  try {
    const tgUser = validateInitData(req.body.initData);
    const user = getOrCreateUser(tgUser);
    res.json({ ok: true, user: safeUser(user) });
  } catch (error) {
    res.status(401).json({ ok: false, error: error.message });
  }
});

/*
 * Создание invoice для выбранной ставки.
 * Пользователь получает Telegram checkout и сам подтверждает оплату.
 */
app.post("/api/payment/invoice", async (req, res) => {
  try {
    const tgUser = validateInitData(req.body.initData);
    const user = getOrCreateUser(tgUser);
    const stake = Number(req.body.stake);

    if (!ALLOWED_STAKES.has(stake)) {
      return res.status(400).json({ ok: false, error: "Недопустимая ставка" });
    }

    if (user.roomId || user.queueStake != null) {
      return res.status(409).json({ ok: false, error: "Вы уже в игре или очереди" });
    }

    const invoice = await createStakeInvoice(user.id, stake);

    res.json({
      ok: true,
      invoiceUrl: invoice.invoiceUrl,
      payload: invoice.payload
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

/*
 * После successful_payment фронтенд может спросить статус payload.
 * Это НЕ замена webhook: окончательным источником истины остаётся
 * successful_payment, пришедший Telegram на сервер.
 */
app.post("/api/payment/status", (req, res) => {
  const p = pendingPayments.get(String(req.body.payload || ""));
  if (!p) return res.status(404).json({ ok: false, error: "Платёж не найден" });

  res.json({
    ok: true,
    status: p.status,
    stake: p.stake
  });
});

/*
 * Отмена поиска.
 */
app.post("/api/queue/cancel", (req, res) => {
  try {
    const tgUser = validateInitData(req.body.initData);
    const user = getOrCreateUser(tgUser);
    removeFromQueue(user.id);
    wsSend(user.ws, "queue_cancelled");
    res.json({ ok: true });
  } catch (error) {
    res.status(401).json({ ok: false, error: error.message });
  }
});

/*
 * Telegram webhook.
 * Установите webhook:
 * POST https://api.telegram.org/bot<TOKEN>/setWebhook
 * body: {"url":"https://DOMAIN/telegram/webhook","secret_token":"..."}
 */
app.post("/telegram/webhook", async (req, res) => {
  try {
    if (
      WEBHOOK_SECRET &&
      req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET
    ) {
      return res.sendStatus(403);
    }

    const update = req.body;

    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      const p = pendingPayments.get(q.invoice_payload);

      const valid =
        p &&
        p.status === "invoice_created" &&
        String(p.userId) === String(q.from.id) &&
        q.currency === "XTR" &&
        Number(q.total_amount) === Number(p.stake);

      if (valid) {
        await telegram("answerPreCheckoutQuery", {
          pre_checkout_query_id: q.id,
          ok: true
        });
      } else {
        await telegram("answerPreCheckoutQuery", {
          pre_checkout_query_id: q.id,
          ok: false,
          error_message: "Счёт недействителен или уже обработан."
        });
      }
    }

    const successful = update.message && update.message.successful_payment;
    if (successful) {
      const p = pendingPayments.get(successful.invoice_payload);

      if (p && successful.currency === "XTR") {
        if (processedCharges.has(successful.telegram_payment_charge_id)) {
          return res.sendStatus(200);
        }

        if (
          Number(successful.total_amount) !== Number(p.stake) ||
          String(update.message.from.id) !== String(p.userId)
        ) {
          p.status = "invalid_payment";
        } else {
          p.status = "paid";
          p.chargeId = successful.telegram_payment_charge_id;

          processedCharges.add(successful.telegram_payment_charge_id);

          const user = users.get(p.userId);
          if (user) user.wallet.paidInStars += p.stake;

          /* Уведомляем Mini App, если пользователь сейчас подключён. */
          if (user && user.ws) {
            wsSend(user.ws, "payment_confirmed", {
              payload: p.payload,
              stake: p.stake
            });
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(200);
  }
});

/* -------------------------- WebSocket ------------------------------ */

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, "http://localhost");
  const initData = url.searchParams.get("initData");

  try {
    const tgUser = validateInitData(initData);
    const user = getOrCreateUser(tgUser);

    socketUsers.set(ws, user.id);
    user.ws = ws;

    wsSend(ws, "connected", { user: safeUser(user) });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        const currentUser = userFromWs(ws);
        if (!currentUser) throw new Error("Сессия не найдена");

        if (msg.type === "ping") {
          wsSend(ws, "pong");
          return;
        }

        if (msg.type === "find_game") {
          const stake = Number(msg.stake);
          enqueue(currentUser, stake);
          wsSend(ws, "searching", { stake });
          return;
        }

        if (msg.type === "move") {
          makeMove(currentUser, Number(msg.index));
          return;
        }

        if (msg.type === "resign") {
          resign(currentUser);
          return;
        }

        throw new Error("Неизвестная команда");
      } catch (error) {
        wsSend(ws, "error", { message: error.message });
      }
    });

    ws.on("close", () => {
      const currentUser = userFromWs(ws);
      socketUsers.delete(ws);

      if (!currentUser) return;

      if (currentUser.ws === ws) currentUser.ws = null;

      /*
       * Если игрок был только в очереди — удаляем его.
       * Если он в матче — закрытие соединения считается поражением.
       */
      if (currentUser.queueStake != null) {
        removeFromQueue(currentUser.id);
      }

      if (currentUser.roomId) {
        const room = rooms.get(currentUser.roomId);
        if (room && !room.ended) {
          const player = getPlayer(room, currentUser.id);
          const opponent = room.players.find(p => p.user.id !== currentUser.id);

          if (player && opponent) {
            finishRoom(room, {
              result: "disconnect",
              winnerSymbol: opponent.symbol,
              loserSymbol: player.symbol
            });
          }
        }
      }
    });
  } catch (error) {
    wsSend(ws, "error", { message: error.message });
    ws.close(1008, "Unauthorized");
  }
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit("connection", ws, request);
  });
});

server.listen(PORT, async () => {
  console.log(`Tic-Tac-Toe server listening on :${PORT}`);

  if (!BOT_TOKEN) {
    console.warn("WARNING: BOT_TOKEN is not set in Render Environment Variables.");
  } else {
    console.log("BOT_TOKEN loaded from Render Environment Variables.");
  }

  if (!PUBLIC_URL) {
    console.warn("WARNING: PUBLIC_URL is not set. Telegram webhook auto-setup is disabled.");
  } else {
    await setupTelegramWebhook();
  }
});
