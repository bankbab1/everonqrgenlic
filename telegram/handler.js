const fs = require("fs");
const crypto = require("crypto");

/* ----------------------------------------
   HELPERS
---------------------------------------- */
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
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

  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };

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
function commandKeyboard(isRegistered) {
  if (isRegistered) {
    return {
      keyboard: [
        [{ text: "/start" }, { text: "/regenqr" }],
        [{ text: "/unregister" }],
        [{ text: "/help" }],
      ],
      resize_keyboard: true,
    };
  }

  return {
    keyboard: [[{ text: "🔐 Register" }], [{ text: "/help" }]],
    resize_keyboard: true,
  };
}

function registeredInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔄 Re-generate Device QR", callback_data: "REGEN_QR" }],
    ],
  };
}

/* ----------------------------------------
   MESSAGES
---------------------------------------- */
function instructionMessage(isRegistered) {
  if (isRegistered) {
    return (
      "🤖 *EverOn Bot*\n\n" +
      "You are already registered.\n\n" +
      "Available commands:\n" +
      "• /start – Show status\n" +
      "• /regenqr – Re-generate device QR\n" +
      "• /unregister – Unlink Telegram\n" +
      "• /help – Show instructions\n\n" +
      "Tap a button below 👇"
    );
  }

  return (
    "🤖 *EverOn Bot*\n\n" +
    "This bot links your EverOn device.\n\n" +
    "Tap *Register* or paste your registration code.\n\n" +
    "Commands:\n" +
    "• /start\n" +
    "• /help"
  );
}

function helpMessage(isRegistered) {
  return isRegistered
    ? (
        "🤖 *EverOn Bot – Help*\n\n" +
        "Commands:\n" +
        "• /start – Show status\n" +
        "• /regenqr – Re-generate device QR\n" +
        "• /unregister – Unlink Telegram\n" +
        "• /help – Show help"
      )
    : (
        "🤖 *EverOn Bot – Help*\n\n" +
        "Commands:\n" +
        "• /start – Start registration\n" +
        "• /register – Register device\n" +
        "• /help – Show help\n\n" +
        "After /start or Register, paste your registration code."
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

  const alreadyRegistered = db.registrations.find(
    (r) => r.telegram_chat_id === chatId
  );

  /* ---------- CALLBACK BUTTON ---------- */
  if (payload.callback_query) {
    if (
      payload.callback_query.data === "REGEN_QR" &&
      alreadyRegistered
    ) {
      const qrUrl = buildEveronQRUrl(chatId, SECRET);
      await sendTelegramPhoto(
        chatId,
        qrUrl,
        "🔐 *New EverOn Link QR*\n\n• Valid for 10 minutes"
      );
    }
    return;
  }

  /* ---------- TEXT MESSAGE ---------- */
  const msg = payload.message;
  if (!msg?.text) return;

  const input = msg.text.trim().toUpperCase();

  /* ---------- COMMANDS ---------- */
  if (input === "/START") {
    await sendTelegram(
      chatId,
      instructionMessage(!!alreadyRegistered),
      commandKeyboard(!!alreadyRegistered)
    );
    return;
  }

  if (input === "/HELP") {
    await sendTelegram(
      chatId,
      helpMessage(!!alreadyRegistered),
      commandKeyboard(!!alreadyRegistered)
    );
    return;
  }

  if (input === "/REGISTER" || input === "🔐 REGISTER") {
    await sendTelegram(
      chatId,
      "🔐 *Register Device*\n\nPlease paste your registration code now."
    );
    return;
  }

  if (input === "/REGENQR") {
    if (!alreadyRegistered) {
      await sendTelegram(chatId, "❌ Please register first using /start");
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

  if (input === "/UNREGISTER") {
    if (!alreadyRegistered) {
      await sendTelegram(chatId, "❌ This Telegram is not registered.");
      return;
    }

    alreadyRegistered.telegram_chat_id = null;
    alreadyRegistered.telegram_bound_at = null;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    await sendTelegram(
      chatId,
      "✅ *Telegram unlinked successfully.*",
      commandKeyboard(false)
    );
    return;
  }

  /* ---------- ALREADY REGISTERED ---------- */
  if (alreadyRegistered) {
    await sendTelegram(
      chatId,
      instructionMessage(true),
      commandKeyboard(true)
    );
    return;
  }

  /* ---------- REGISTRATION CODE FLOW (UNCHANGED CORE) ---------- */
  if (!/^[A-Z0-9]{6,32}$/.test(input)) {
    await sendTelegram(
      chatId,
      instructionMessage(false),
      commandKeyboard(false)
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

  match.telegram_chat_id = chatId;
  match.telegram_bound_at = new Date().toISOString();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

  await sendTelegram(chatId, "✅ *Registration successful*");

  const qrUrl = buildEveronQRUrl(chatId, SECRET);
  await sendTelegramPhoto(
    chatId,
    qrUrl,
    "🔐 *Secure EverOn Link QR*\n\n• Valid for 10 minutes",
    registeredInlineKeyboard()
  );
}

run().catch(console.error);
