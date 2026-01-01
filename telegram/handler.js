const fs = require("fs");
const crypto = require("crypto");

/* ----------------------------------------
   HELPERS
---------------------------------------- */
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
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
function commandKeyboard(isRegistered) {
  return isRegistered
    ? {
        keyboard: [
          [{ text: "/start" }, { text: "/regenqr" }],
          [{ text: "/unregister" }],
          [{ text: "/help" }],
        ],
        resize_keyboard: true,
      }
    : {
        keyboard: [[{ text: "/start" }], [{ text: "/help" }]],
        resize_keyboard: true,
      };
}

/* ----------------------------------------
   HELP MESSAGE
---------------------------------------- */
function helpMessage(isRegistered) {
  if (isRegistered) {
    return (
      "🤖 *EverOn Bot – Help*\n\n" +
      "Available commands:\n" +
      "• `/start` – Show current status\n" +
      "• `/regenqr` – Re-generate device QR\n" +
      "• `/unregister` – Unlink this Telegram\n" +
      "• `/help` – Show this help message"
    );
  }

  return (
    "🤖 *EverOn Bot – Help*\n\n" +
    "Available commands:\n" +
    "• `/start` – Start registration\n" +
    "• `/register` – Register device (or just paste code)\n" +
    "• `/help` – Show this help message\n\n" +
    "_After /start or /register, paste your registration code._"
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

  const msg = payload.message;
  if (!msg?.text) return;

  const input = msg.text.trim().toUpperCase();

  /* ---------- /START ---------- */
  if (input === "/START") {
    await sendTelegram(
      chatId,
      alreadyRegistered
        ? "🤖 *EverOn Bot*\n\nYou are already registered."
        : "🤖 *EverOn Bot*\n\nPlease enter your registration code.",
      commandKeyboard(!!alreadyRegistered)
    );
    return;
  }

  /* ---------- /HELP ---------- */
  if (input === "/HELP") {
    await sendTelegram(
      chatId,
      helpMessage(!!alreadyRegistered),
      commandKeyboard(!!alreadyRegistered)
    );
    return;
  }

  /* ---------- /REGISTER (PROMPT ONLY) ---------- */
  if (input === "/REGISTER") {
    if (alreadyRegistered) {
      await sendTelegram(chatId, "✅ You are already registered.");
      return;
    }

    await sendTelegram(
      chatId,
      "🔐 *Register Device*\n\nPlease paste your registration code now."
    );
    return;
  }

  /* ---------- /REGENQR ---------- */
  if (input === "/REGENQR") {
    if (!alreadyRegistered) {
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

  /* ---------- IF ALREADY REGISTERED ---------- */
  if (alreadyRegistered) {
    await sendTelegram(
      chatId,
      "✅ You are already registered.\nUse `/help` to see available commands.",
      commandKeyboard(true)
    );
    return;
  }

  /* ----------------------------------------
     REGISTRATION CODE FLOW
  ---------------------------------------- */
  if (!/^[A-Z0-9]{6,32}$/.test(input)) {
    await sendTelegram(
      chatId,
      "❌ Invalid input.\n\nPlease enter a valid registration code.",
      commandKeyboard(false)
    );
    return;
  }

  const hash = sha256(input + SECRET);
  const match = db.registrations.find((r) => r.reg_hash === hash);

  if (!match) {
    await sendTelegram(chatId, "❌ Invalid registration code.");
    return;
  }

  if (!isActiveRegistration(match)) {
    await sendTelegram(chatId, "❌ Registration inactive or expired.");
    return;
  }

  match.telegram_chat_id = chatId;
  match.telegram_bound_at = new Date().toISOString();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

  await sendTelegram(chatId, "🎉 *Registration successful!*");

  const qrUrl = buildEveronQRUrl(chatId, SECRET);
  await sendTelegramPhoto(
    chatId,
    qrUrl,
    "🔐 *Secure EverOn Link QR*\n\n• Valid for 10 minutes"
  );
}

run().catch(console.error);
