/**
 * EverOn Telegram Bot Handler
 * Stateless-safe (GitHub Actions)
 *
 * Flow:
 * /start → Register (optional) → enter code → validate → link → QR
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

function isCodeFormat(text) {
  return /^[A-Z0-9]{6,32}$/.test(text);
}

function isRegistered(db, chatId) {
  return db.registrations.find(r => r.telegram_chat_id === chatId);
}

function findByRegCode(db, code, secret) {
  const hash = sha256(code + secret);
  return db.registrations.find(r => r.reg_hash === hash);
}

function isRegistrationActive(r) {
  if (!r) return { ok: false, reason: "not_found" };

  if (String(r.status || "").toLowerCase() !== "active") {
    return { ok: false, reason: "not_active" };
  }

  const now = today();

  if (r.valid_from && now < r.valid_from)
    return { ok: false, reason: "not_started" };

  if (r.valid_until && now > r.valid_until)
    return { ok: false, reason: "expired" };

  return { ok: true };
}

/* ----------------------------------------
   EVERON QR
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
   TELEGRAM API
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
   UI
---------------------------------------- */

function keyboard(registered) {
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

function intro(registered) {
  return registered
    ? "🤖 *EverOn Bot*\n\n✅ Telegram linked.\n\n• /regenqr\n• /unregister\n• /help"
    : "🤖 *EverOn Bot*\n\nThis bot links your EverOn device.\n\nTap *Register* or paste your registration code.";
}

/* ----------------------------------------
   MAIN
---------------------------------------- */

async function run() {
  if (!process.env.TG_PAYLOAD) return;

  const payload = JSON.parse(process.env.TG_PAYLOAD);
  const SECRET = (process.env.REG_SECRET || "").trim().toUpperCase();
  if (!SECRET) return;

  /* ---------- SYSTEM EVENTS ---------- */

  if (payload.type === "SEND_TEST") {
    await sendTelegram(payload.chat_id, "🧪 *EverOn Test*\n\n✅ OK");
    return;
  }

  /* ---------- MESSAGE ---------- */

  const chatId =
    payload.message?.chat?.id ||
    payload.callback_query?.message?.chat?.id;

  if (!chatId) return;

  const input = extractText(payload).toUpperCase();
  if (!input) return;

  const dbPath = "registration.json";
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

  let registered = isRegistered(db, chatId);

  /* ---------- COMMANDS ---------- */

  if (input === "/START" || input === "/HELP") {
    await sendTelegram(chatId, intro(!!registered), keyboard(!!registered));
    return;
  }

  if (input === "/REGENQR") {
    if (!registered) {
      await sendTelegram(chatId, "❌ Please register first.");
      return;
    }

    const qr = buildEveronQRUrl(chatId, SECRET);
    await sendTelegramPhoto(chatId, qr, "🔐 *EverOn QR*\n• Valid 10 minutes");
    return;
  }

  if (input === "/UNREGISTER") {
    if (!registered) {
      await sendTelegram(chatId, "❌ Not registered.");
      return;
    }

    registered.telegram_chat_id = null;
    registered.telegram_bound_at = null;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    await sendTelegram(chatId, "✅ Unlinked.", keyboard(false));
    return;
  }

  if (input === "🔐 REGISTER") {
    if (registered) {
      await sendTelegram(chatId, "✅ Already registered.");
      return;
    }

    await sendTelegram(
      chatId,
      "🔐 *Register Device*\n\nPlease enter your registration code now.",
      { remove_keyboard: true }
    );
    return;
  }

  /* ---------- REGISTRATION CODE ---------- */

  if (!registered && isCodeFormat(input)) {
    const match = findByRegCode(db, input, SECRET);

    if (!match) {
      await sendTelegram(chatId, "❌ Invalid registration code.", keyboard(false));
      return;
    }

    const check = isRegistrationActive(match);
    if (!check.ok) {
      const msg =
        check.reason === "expired"
          ? "❌ Subscription expired."
          : "❌ Registration inactive.";
      await sendTelegram(chatId, msg, keyboard(false));
      return;
    }

    match.telegram_chat_id = chatId;
    match.telegram_bound_at = new Date().toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    registered = match;

    await sendTelegram(chatId, "🎉 *Registration successful!*", keyboard(true));

    const qr = buildEveronQRUrl(chatId, SECRET);
    await sendTelegramPhoto(chatId, qr, "🔐 *Secure EverOn Link QR*\n• 10 minutes");

    return;
  }

  /* ---------- FALLBACK ---------- */

  await sendTelegram(chatId, intro(!!registered), keyboard(!!registered));
}

run().catch(console.error);
