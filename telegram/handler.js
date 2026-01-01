const fs = require("fs");
const crypto = require("crypto");

/* ----------------------------------------
   HELPERS
---------------------------------------- */
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Accept: ABC123
function looksLikeRegCode(input) {
  return /^[A-Z0-9:-]{6,64}$/.test(input); // allow - and :
}

// Generate candidate strings to hash (to match how reg_hash might be generated)
function regCodeCandidates(input) {
  const s = input.trim().toUpperCase().replace(/\s+/g, "");

  const candidates = new Set();
  candidates.add(s);

  // If user pastes
  if (s.includes("::")) {
    const after = s.split("::").pop();
    if (after) candidates.add(after);
  }

  // Common normalization: remove hyphens
  candidates.forEach((c) => {
    candidates.add(c.replace(/-/g, ""));
  });

  // Also if after ::, remove hyphens too
  if (s.includes("::")) {
    const after = s.split("::").pop() || "";
    candidates.add(after.replace(/-/g, ""));
  }

  return Array.from(candidates);
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

async function sendTelegramPhoto(chatId, photoUrl, caption = "", keyboard = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const body = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "Markdown",
  };

  if (keyboard) body.reply_markup = keyboard;

  await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
      "Commands:\n" +
      "• /start – Show status\n" +
      "• /regenqr – Re-generate device QR\n" +
      "• /unregister – Unlink Telegram\n" +
      "• /help – Show help\n\n" +
      "Tap a button below 👇"
    );
  }

  return (
    "🤖 *EverOn Bot*\n\n" +
    "This bot links your EverOn device.\n\n" +
    "Tap *Register* or paste your registration code.\n\n" +
    "Example code format:\n" +
    "`XXXX-XXXX-XXXX`"
  );
}

function helpMessage(isRegistered) {
  return isRegistered
    ? (
        "🤖 *EverOn Bot – Help*\n\n" +
        "• /start – Show status\n" +
        "• /regenqr – Re-generate device QR\n" +
        "• /unregister – Unlink Telegram\n" +
        "• /help – Show help"
      )
    : (
        "🤖 *EverOn Bot – Help*\n\n" +
        "• /start – Start\n" +
        "• /register – Show register prompt\n" +
        "• /help – Show help\n\n" +
        "Then paste your registration code like:\n" +
        "`XXXX-XXXX-XXXX`"
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

  /* ----------------------------------------
     CALLBACK BUTTONS
  ---------------------------------------- */
  if (payload.callback_query) {
    if (payload.callback_query.data === "REGEN_QR" && alreadyRegistered) {
      const qrUrl = buildEveronQRUrl(chatId, SECRET);
      await sendTelegramPhoto(
        chatId,
        qrUrl,
        "🔐 *New EverOn Link QR*\n\n• Valid for 10 minutes"
      );
    }
    return;
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
      commandKeyboard(!!alreadyRegistered)
    );
    return;
  }

  // /HELP
  if (input === "/HELP") {
    await sendTelegram(
      chatId,
      helpMessage(!!alreadyRegistered),
      commandKeyboard(!!alreadyRegistered)
    );
    return;
  }

  // /REGISTER or button "🔐 Register"
  if (input === "/REGISTER" || input === "🔐 REGISTER") {
    if (alreadyRegistered) {
      await sendTelegram(chatId, "✅ You are already registered.");
      return;
    }
    await sendTelegram(
      chatId,
      "🔐 *Register Device*\n\nPlease paste your registration code now.\nExample: `XXXX-XXXX-XXXX`"
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
    await sendTelegramPhoto(
      chatId,
      qrUrl,
      "🔐 *New EverOn Link QR*\n\n• Valid for 10 minutes"
    );
    return;
  }

  // /UNREGISTER
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
        "✅ *Telegram unlinked successfully.*\n\n" +
        "⏳ *Important:*\n" +
        "This change may take up to *5 minutes* to fully take effect.\n\n" +
        "During this time, one last payment slip may still be delivered.",
        commandKeyboard(false)
      );

    return;
  }

  /* ----------------------------------------
     ALREADY REGISTERED → SHOW HELP
  ---------------------------------------- */
  if (alreadyRegistered) {
    await sendTelegram(
      chatId,
      instructionMessage(true),
      commandKeyboard(true)
    );
    return;
  }

  /* ----------------------------------------
     REGISTRATION CODE FLOW
     (NOW SUPPORTS HYPHEN CODES)
  ---------------------------------------- */
  if (!looksLikeRegCode(input)) {
    await sendTelegram(
      chatId,
      instructionMessage(false),
      commandKeyboard(false)
    );
    return;
  }

  // Try multiple candidate formats to match your reg_hash generator
  const candidates = regCodeCandidates(input);

  let match = null;
  for (const c of candidates) {
    const hash = sha256(c + SECRET);
    match = db.registrations.find((r) => r.reg_hash === hash);
    if (match) break;
  }

  if (!match) {
    await sendTelegram(
      chatId,
      "❌ Invalid registration code.\n\nPlease try again or use /help"
    );
    return;
  }

  // (Optional) if you want to enforce status/date, uncomment below:
  // if (String(match.status || "").toLowerCase() !== "active") {
  //   await sendTelegram(chatId, "❌ Registration inactive or expired.");
  //   return;
  // }

  match.telegram_chat_id = chatId;
  match.telegram_bound_at = new Date().toISOString();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

  await sendTelegram(
     chatId,
     "✅ *Registration successful*\n\n" +
     "⏳ *Note:*\n" +
     "It may take up to *5 minutes* before payment slips start arriving.\n\n" +
     "Please wait a moment before testing.",
     commandKeyboard(true)
   );


  const qrUrl = buildEveronQRUrl(chatId, SECRET);
  await sendTelegramPhoto(
    chatId,
    qrUrl,
    "🔐 *Secure EverOn Link QR*\n\n• Valid for 10 minutes",
    registeredInlineKeyboard()
  );
}

run().catch(console.error);
