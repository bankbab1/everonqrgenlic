/**
 * EverOn Telegram Bot Handler
 * GitHub Actions safe (stateless)
 *
 * Flow:
 * /start → 🔐 Register → paste code → validate → link → QR
 *
 * Commands:
 * /start /help /regenqr /unregister
 */

const fs = require("fs");
const crypto = require("crypto");

/* ----------------------------------------
   HELPERS
---------------------------------------- */
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function extractText(payload) {
  return (
    payload.message?.text ||
    payload.message?.caption ||
    payload.callback_query?.data ||
    ""
  ).trim();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isActiveRegistration(r) {
  if (!r) return false;
  if (String(r.status || "").toLowerCase() !== "active") return false;
  if (r.valid_from && today() < r.valid_from) return false;
  if (r.valid_until && today() > r.valid_until) return false;
  return true;
}

/* ----------------------------------------
   EVERON QR HELPERS
---------------------------------------- */
function signEveronPayload(chatId, ts, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${chatId}.${ts}`)
    .digest("hex");
}

function buildEveronQRUrl(chatId, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = { v: 1, cid: String(chatId), ts };
  payload.sig = signEveronPayload(payload.cid, payload.ts, secret);

  const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const deepLink =
    "everon://telegram-link?payload=" + encodeURIComponent(base64);

  return (
    "https://api.qrserver.com/v1/create-qr-code/?" +
    "size=360x360&data=" +
    encodeURIComponent(deepLink)
  );
}

/* ----------------------------------------
   TELEGRAM HELPERS
---------------------------------------- */
async function sendTelegram(chatId, text, keyboard = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const body = { chat_id: chatId, text, parse_mode: "Markdown" };
  if (keyboard) body.reply_markup = keyboard;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendTelegramPhoto(chatId, photoUrl, caption = "") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: "Markdown",
    }),
  });
}

/* ----------------------------------------
   KEYBOARDS
---------------------------------------- */
function mainKeyboard(registered) {
  return registered
    ? {
        keyboard: [
          [{ text: "/regenqr" }],
          [{ text: "/unregister" }],
          [{ text: "/help" }],
        ],
        resize_keyboard: true,
      }
    : {
        keyboard: [[{ text: "🔐 Register" }], [{ text: "/help" }]],
        resize_keyboard: true,
      };
}

function regenInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔄 Re-generate Device QR", callback_data: "REGEN_QR" }],
    ],
  };
}

/* ----------------------------------------
   MESSAGES
---------------------------------------- */
function introMessage(registered) {
  return registered
    ? (
        "🤖 *EverOn Bot*\n\n" +
        "✅ Telegram linked.\n\n" +
        "Commands:\n" +
        "• /regenqr – Re-generate device QR\n" +
        "• /unregister – Unlink Telegram\n" +
        "• /help – Show help\n\n" +
        "Tap a button below 👇"
      )
    : (
        "🤖 *EverOn Bot*\n\n" +
        "This bot links your EverOn device.\n\n" +
        "Tap *Register* or paste your registration code."
      );
}

function helpMessage(registered) {
  return registered
    ? (
        "🤖 *EverOn Bot – Help*\n\n" +
        "• /start – Show status\n" +
        "• /regenqr – Re-generate device QR\n" +
        "• /unregister – Unlink Telegram\n" +
        "• /help – Show this help"
      )
    : (
        "🤖 *EverOn Bot – Help*\n\n" +
        "• /start – Start registration\n" +
        "• /register – Register device\n" +
        "• /help – Show this help\n\n" +
        "After /start or /register, paste your registration code."
      );
}

/* ----------------------------------------
   MAIN HANDLER
---------------------------------------- */
async function run() {
  if (!process.env.TG_PAYLOAD) return;

  const payload = JSON.parse(process.env.TG_PAYLOAD);
  const SECRET = (process.env.REG_SECRET || "").trim().toUpperCase();
  if (!SECRET) return;

  const dbPath = "registration.json";
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

  const chatId =
    payload.message?.chat?.id ||
    payload.callback_query?.message?.chat?.id;
  if (!chatId) return;

  const registered = db.registrations.find(
    (r) => r.telegram_chat_id === chatId
  );

  /* ---------- CALLBACK (INLINE BUTTON) ---------- */
  if (payload.callback_query) {
    if (payload.callback_query.data === "REGEN_QR" && registered) {
      const qrUrl = buildEveronQRUrl(chatId, SECRET);
      await sendTelegramPhoto(
        chatId,
        qrUrl,
        "🔐 *New EverOn Link QR*\n\n• Valid for 10 minutes"
      );
    }
    return;
  }

  const input = extractText(payload).toUpperCase();
  if (!input) return;

  /* ---------- /START ---------- */
  if (input === "/START") {
    await sendTelegram(
      chatId,
      introMessage(!!registered),
      mainKeyboard(!!registered)
    );
    return;
  }

  /* ---------- /HELP ---------- */
  if (input === "/HELP") {
    await sendTelegram(
      chatId,
      helpMessage(!!registered),
      mainKeyboard(!!registered)
    );
    return;
  }

  /* ---------- /REGISTER ---------- */
  if (input === "/REGISTER" || input === "🔐 REGISTER") {
    if (registered) {
      await sendTelegram(chatId, "✅ You are already registered.");
      return;
    }

    await sendTelegram(
      chatId,
      "🔐 *Register Device*\n\nPlease paste your registration code now.",
      { remove_keyboard: true }
    );
    return;
  }

  /* ---------- /REGENQR ---------- */
  if (input === "/REGENQR") {
    if (!registered) {
      await sendTelegram(chatId, "❌ Please register first.");
      return;
    }

    const qrUrl = buildEveronQRUrl(chatId, SECRET);
    await sendTelegramPhoto(
      chatId,
      qrUrl,
      "🔐 *New EverOn Link QR*\n\n• Valid for 10 minutes"
    );
    return;
  }

  /* ---------- /UNREGISTER ---------- */
  if (input === "/UNREGISTER") {
    if (!registered) {
      await sendTelegram(chatId, "❌ This Telegram is not registered.");
      return;
    }

    registered.telegram_chat_id = null;
    registered.telegram_bound_at = null;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    await sendTelegram(
      chatId,
      "✅ *Telegram unlinked successfully.*",
      mainKeyboard(false)
    );
    return;
  }

  /* ---------- ALREADY REGISTERED ---------- */
  if (registered) {
    await sendTelegram(
      chatId,
      introMessage(true),
      mainKeyboard(true)
    );
    return;
  }

  /* ---------- REGISTRATION CODE FLOW (PROVEN) ---------- */
  if (!/^[A-Z0-9]{6,32}$/.test(input)) {
    await sendTelegram(
      chatId,
      introMessage(false),
      mainKeyboard(false)
    );
    return;
  }

  const hash = sha256(input + SECRET);
  const match = db.registrations.find((r) => r.reg_hash === hash);

  if (!match) {
    await sendTelegram(
      chatId,
      "❌ Invalid registration code.\n\nPlease try again or use /help"
    );
    return;
  }

  if (!isActiveRegistration(match)) {
    await sendTelegram(chatId, "❌ Registration inactive or expired.");
    return;
  }

  match.telegram_chat_id = chatId;
  match.telegram_bound_at = new Date().toISOString();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

  await sendTelegram(
    chatId,
    "🎉 *Registration successful!*",
    mainKeyboard(true)
  );

  const qrUrl = buildEveronQRUrl(chatId, SECRET);
  await sendTelegramPhoto(
    chatId,
    qrUrl,
    "🔐 *Secure EverOn Link QR*\n\n• Valid for 10 minutes",
    regenInlineKeyboard()
  );
}

run().catch(console.error);
