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

  const payload = {
    v: 1,
    cid: String(chatId),
    ts,
  };

  payload.sig = signEveronPayload(payload.cid, payload.ts, secret);

  const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  const deepLink =
    `everon://telegram-link?payload=` + encodeURIComponent(base64);

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
function registerKeyboard() {
  return {
    inline_keyboard: [[{ text: "🔐 Register", callback_data: "REGISTER" }]],
  };
}

function registeredKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔄 Re-generate Device QR", callback_data: "REGEN_QR" }],
    ],
  };
}

/* ----------------------------------------
   INSTRUCTION / HELP MESSAGE
---------------------------------------- */
function instructionMessage(isRegistered) {
  if (isRegistered) {
    return (
      "🤖 *EverOn Bot*\n\n" +
      "You are already registered.\n\n" +
      "Available commands:\n" +
      "• `/start` – Show status\n" +
      "• `/regenqr` – Re-generate device QR\n" +
      "• `/help` – Show instructions\n\n" +
      "Or use the button below 👇"
    );
  }

  return (
    "🤖 *EverOn Bot*\n\n" +
    "This bot is used to link your EverOn device.\n\n" +
    "Available commands:\n" +
    "• `/start` – Start registration\n" +
    "• `/help` – Show instructions\n\n" +
    "Please register before using the device."
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

  /* ----------------------------------------
     SYSTEM EVENTS (FROM APP)
  ---------------------------------------- */
  if (payload.type === "SEND_TEST") {
    await sendTelegram(
      payload.chat_id,
      "🧪 *EverOn Test Payment Slip*\n\n" +
        "✅ Telegram connection is working correctly."
    );
    return;
  }

  if (payload.type === "SEND_SLIP") {
    const { chat_id, image_base64, meta } = payload;
    if (!chat_id || !image_base64) return;

    const buffer = Buffer.from(image_base64, "base64");
    const caption =
      "🧾 *Payment Slip Received*\n\n" +
      `🏦 Bank: ${meta?.bank ?? "-"}\n` +
      `🔢 Ref: ${meta?.ref ?? "-"}\n` +
      `💰 Amount: ${meta?.amount ?? "-"}`;

    const form = new FormData();
    form.append("chat_id", chat_id);
    form.append("photo", buffer, { filename: "slip.jpg" });
    form.append("caption", caption);
    form.append("parse_mode", "Markdown");

    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
      { method: "POST", body: form }
    );
    return;
  }

  /* ----------------------------------------
     TELEGRAM MESSAGE HANDLING
  ---------------------------------------- */
  const dbPath = "registration.json";
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

  const chatId =
    payload.message?.chat?.id ||
    payload.callback_query?.message?.chat?.id;
  if (!chatId) return;

  const alreadyRegistered = db.registrations.find(
    (r) => r.telegram_chat_id === chatId
  );

  /* ----------------------------------------
     CALLBACK BUTTONS
  ---------------------------------------- */
  if (payload.callback_query) {
    const action = payload.callback_query.data;

    if (action === "REGISTER") {
      await sendTelegram(
        chatId,
        alreadyRegistered
          ? instructionMessage(true)
          : "🧾 Please send your *Registration Code*.",
        alreadyRegistered ? registeredKeyboard() : null
      );
      return;
    }

    if (action === "REGEN_QR" && alreadyRegistered) {
      const qrUrl = buildEveronQRUrl(chatId, SECRET);
      await sendTelegramPhoto(
        chatId,
        qrUrl,
        "🔐 *New EverOn Link QR*\n\n• Valid for 10 minutes"
      );
      return;
    }
  }

  /* ----------------------------------------
     TEXT MESSAGES
  ---------------------------------------- */
  const msg = payload.message;
  if (!msg?.text) return;

  const input = msg.text.trim().toUpperCase();

  // /START
  if (input === "/START") {
    await sendTelegram(
      chatId,
      instructionMessage(!!alreadyRegistered),
      alreadyRegistered ? registeredKeyboard() : registerKeyboard()
    );
    return;
  }

  // /REGENQR
  if (input === "/REGENQR") {
    if (!alreadyRegistered) {
      await sendTelegram(chatId, "❌ Please register first using /start");
      return;
    }

    const qrUrl = buildEveronQRUrl(chatId, SECRET);
    await sendTelegramPhoto(chatId, qrUrl, "🔐 *New EverOn Link QR*\n\n• Valid for 10 minutes");
    return;
  }

  // /HELP
  if (input === "/HELP") {
    await sendTelegram(
      chatId,
      instructionMessage(!!alreadyRegistered),
      alreadyRegistered ? registeredKeyboard() : registerKeyboard()
    );
    return;
  }

  /* ----------------------------------------
     FALLBACK → SHOW INSTRUCTIONS
  ---------------------------------------- */
  if (!/^[A-Z0-9]+$/.test(input)) {
    await sendTelegram(
      chatId,
      instructionMessage(!!alreadyRegistered),
      alreadyRegistered ? registeredKeyboard() : registerKeyboard()
    );
    return;
  }

  /* ----------------------------------------
     REGISTRATION CODE FLOW
  ---------------------------------------- */
  const hash = sha256(input + SECRET);
  const match = db.registrations.find((r) => r.reg_hash === hash);

  if (!match) {
    await sendTelegram(chatId, "❌ Invalid registration code.");
    return;
  }

  match.telegram_chat_id = chatId;
  match.telegram_bound_at = new Date().toISOString();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

  await sendTelegram(chatId, "✅ *Registration successful*");

  const qrUrl = buildEveronQRUrl(chatId, SECRET);
  await sendTelegramPhoto(chatId, qrUrl, "🔐 *Secure EverOn Link QR*");
}

run().catch(console.error);
