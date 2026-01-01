/**
 * EverOn Telegram Bot Handler (GitHub Actions / Stateless Safe)
 * Flow:
 * /start → Register button (optional prompt) → enter code → validate → link → QR
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

function nowISODate() {
  // compare by date only (YYYY-MM-DD)
  return new Date().toISOString().slice(0, 10);
}

function isCodeFormat(input) {
  return /^[A-Z0-9]{6,32}$/.test(input);
}

function isRegistered(db, chatId) {
  return db.registrations.find((r) => r.telegram_chat_id === chatId);
}

function isRegistrationActive(r) {
  const today = nowISODate();

  if (!r) return { ok: false, reason: "not_found" };

  // status check
  if (String(r.status || "").toLowerCase() !== "active") {
    return { ok: false, reason: "not_active" };
  }

  // date check (if fields exist)
  if (r.valid_from && today < r.valid_from) {
    return { ok: false, reason: "not_started" };
  }

  if (r.valid_until && today > r.valid_until) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true };
}

function findByRegCode(db, regCode, secret) {
  const hash = sha256(regCode + secret);
  return db.registrations.find((r) => r.reg_hash === hash);
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
    sig: signEveronPayload(chatId, ts, secret),
  };

  const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const deepLink = "everon://telegram-link?payload=" + encodeURIComponent(base64);

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
function commandKeyboard(registered) {
  if (registered) {
    return {
      keyboard: [
        [{ text: "/regenqr" }],
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

/* ----------------------------------------
   MESSAGES
---------------------------------------- */
function instructionMessage(registered) {
  if (registered) {
    return (
      "🤖 *EverOn Bot*\n\n" +
      "✅ Your Telegram is linked.\n\n" +
      "Commands:\n" +
      "• /regenqr – Generate device QR\n" +
      "• /unregister – Unlink Telegram\n" +
      "• /help – Show help"
    );
  }

  return (
    "🤖 *EverOn Bot*\n\n" +
    "This bot links your EverOn device.\n\n" +
    "Tap *Register* then enter your registration code.\n" +
    "_(You can also paste the code directly.)_"
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
      "🧪 *EverOn Test*\n\n✅ Telegram connection OK"
    );
    return;
  }

  if (payload.type === "SEND_SLIP") {
    const { chat_id, image_base64, meta } = payload;
    if (!chat_id || !image_base64) return;

    const buffer = Buffer.from(image_base64, "base64");

    const caption =
      "🧾 *Payment Slip*\n\n" +
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
    payload.message?.chat?.id || payload.callback_query?.message?.chat?.id;
  if (!chatId) return;

  const msg = payload.message;
  if (!msg?.text) return;

  const input = msg.text.trim().toUpperCase();

  let registered = isRegistered(db, chatId);

  /* ----------------------------------------
     BASIC COMMANDS
  ---------------------------------------- */
  if (input === "/START" || input === "/HELP") {
    await sendTelegram(
      chatId,
      instructionMessage(!!registered),
      commandKeyboard(!!registered)
    );
    return;
  }

  if (input === "/REGENQR") {
    if (!registered) {
      await sendTelegram(chatId, "❌ Please register first.");
      return;
    }

    const qrUrl = buildEveronQRUrl(chatId, SECRET);
    await sendTelegramPhoto(
      chatId,
      qrUrl,
      "🔐 *EverOn Device QR*\n\n• Valid for 10 minutes"
    );
    return;
  }

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
      "✅ *Telegram unlinked successfully*",
      commandKeyboard(false)
    );
    return;
  }

  /* ----------------------------------------
     REGISTER BUTTON (PROMPT ONLY)
     (No memory needed)
  ---------------------------------------- */
  if (input === "🔐 REGISTER") {
    if (registered) {
      await sendTelegram(chatId, "✅ You are already registered.");
      return;
    }

    await sendTelegram(
      chatId,
      "🔐 *Register Device*\n\nPlease enter your registration code now.",
      { remove_keyboard: true }
    );
    return;
  }

  /* ----------------------------------------
     ✅ REGISTRATION CODE (STATELESS SAFE)
     If not registered + message looks like code,
     validate immediately (NO registerMode needed).
  ---------------------------------------- */
  if (!registered && isCodeFormat(input)) {
    const match = findByRegCode(db, input, SECRET);

    if (!match) {
      await sendTelegram(
        chatId,
        "❌ Invalid registration code.\n\nPlease try again.",
        commandKeyboard(false)
      );
      return;
    }

    // subscription/status/date checks
    const activeCheck = isRegistrationActive(match);
    if (!activeCheck.ok) {
      let reason = "❌ This registration is not active.";
      if (activeCheck.reason === "expired") reason = "❌ Subscription expired.";
      if (activeCheck.reason === "not_started")
        reason = "❌ Subscription not started yet.";
      if (activeCheck.reason === "not_active")
        reason = "❌ Registration status is not active.";

      await sendTelegram(chatId, reason, commandKeyboard(false));
      return;
    }

    // bind
    match.telegram_chat_id = chatId;
    match.telegram_bound_at = new Date().toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    registered = match;

    await sendTelegram(
      chatId,
      "🎉 *Registration successful!*",
      commandKeyboard(true)
    );

    const qrUrl = buildEveronQRUrl(chatId, SECRET);
    await sendTelegramPhoto(
      chatId,
      qrUrl,
      "🔐 *Secure EverOn Link QR*\n\n• Valid for 10 minutes"
    );
    return;
  }

  /* ----------------------------------------
     FALLBACK
  ---------------------------------------- */
  await sendTelegram(
    chatId,
    instructionMessage(!!registered),
    commandKeyboard(!!registered)
  );
}

run().catch(console.error);
