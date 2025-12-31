const fs = require("fs");
const crypto = require("crypto");

// --------------------
// Helpers
// --------------------
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// --------------------
// EverOn QR helpers
// --------------------
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

  // QR image service
  return (
    "https://api.qrserver.com/v1/create-qr-code/?" +
    "size=360x360&data=" +
    encodeURIComponent(deepLink)
  );
}


async function sendTelegram(chatId, text, keyboard = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN missing");
    return;
  }

  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };

  if (keyboard) {
    body.reply_markup = keyboard;
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendTelegramPhoto(chatId, photoUrl, caption = "") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN missing");
    return;
  }

  const body = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "Markdown",
  };

  await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}


// Standard register button
function registerKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🔐 Register",
          callback_data: "REGISTER",
        },
      ],
    ],
  };
}

// --------------------
// Main handler
// --------------------
async function run() {
  if (!process.env.TG_PAYLOAD) {
    console.log("No TG_PAYLOAD");
    return;
  }

  const payload = JSON.parse(process.env.TG_PAYLOAD);
  const SECRET = (process.env.REG_SECRET || "").trim().toUpperCase();

  if (!SECRET) {
    console.error("REG_SECRET missing");
    return;
  }

  const dbPath = "registration.json";
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

  // --------------------
  // Detect already-registered chat (GLOBAL GUARD)
  // --------------------
  let chatId = null;

  if (payload.message?.chat?.id) {
    chatId = payload.message.chat.id;
  } else if (payload.callback_query?.message?.chat?.id) {
    chatId = payload.callback_query.message.chat.id;
  }

  const alreadyRegistered = chatId
    ? db.registrations.find((r) => r.telegram_chat_id === chatId)
    : null;

  // --------------------
  // Handle button click
  // --------------------
  if (payload.callback_query) {
    const cb = payload.callback_query;

    if (cb.data === "REGISTER") {
      if (alreadyRegistered) {
        await sendTelegram(
          chatId,
          "✅ This chat is already registered.\n\nYou will receive EverOn notifications here."
        );
      } else {
        await sendTelegram(
          chatId,
          "🧾 Please send your *Registration Code*.\n\nExample:\nABC123XYZ"
        );
      }
    }
    return;
  }

  // --------------------
  // Handle text message
  // --------------------
  const msg = payload.message;
  if (!msg || !msg.text) return;

  const text = msg.text.trim();
  const input = text.toUpperCase();

  // --------------------
  // /start command
  // --------------------
  if (input === "/START") {
    if (alreadyRegistered) {
      await sendTelegram(
        chatId,
        "✅ This chat is already registered.\n\nYou will receive EverOn notifications here."
      );
    } else {
      await sendTelegram(
        chatId,
        "👋 Welcome to EverOn Bot\n\nFor the Store Owner, please register first.",
        registerKeyboard()
      );
    }
    return;
  }

  // --------------------
  // BLOCK: chat already registered
  // --------------------
  if (alreadyRegistered) {
    await sendTelegram(
      chatId,
      "ℹ️ This chat is already registered.\n\nNo further action is required."
    );
    return;
  }

  // --------------------
  // Try registration code
  // --------------------
  const hash = sha256(input + SECRET);
  const match = db.registrations.find((r) => r.reg_hash === hash);

  if (!match) {
    await sendTelegram(
      chatId,
      "❌ Invalid registration code.\n\nFor the Store Owner, please register first.",
      registerKeyboard()
    );
    return;
  }

  // --------------------
  // Status check
  // --------------------
  if (match.status !== "active") {
    await sendTelegram(
      chatId,
      "⛔ This registration is not active.\nPlease contact EverOn support."
    );
    return;
  }

  // --------------------
  // Expiry check
  // --------------------
  if (match.valid_until) {
    const now = new Date();
    const until = new Date(match.valid_until);

    if (now > until) {
      await sendTelegram(
        chatId,
        "⛔ This registration has expired.\nPlease renew your subscription."
      );
      return;
    }
  }

  // --------------------
  // Prevent reuse in another chat
  // --------------------
  if (match.telegram_chat_id && match.telegram_chat_id !== chatId) {
    await sendTelegram(
      chatId,
      "⚠️ This registration code is already linked to another Telegram chat."
    );
    return;
  }

  // --------------------
  // First-time bind (ONLY PLACE THAT WRITES)
  // --------------------
  match.telegram_chat_id = chatId;
  match.telegram_bound_at = new Date().toISOString();

  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

  // --------------------
  // Success
  // --------------------
  // --------------------
// Success + EverOn QR
// --------------------
await sendTelegram(
  chatId,
  "✅ *Registration successful*\n\n" +
    "📲 Next step:\n" +
    "Open your *EverOn device* → Payment Slip → Scan QR to link this chat."
);

const qrUrl = buildEveronQRUrl(chatId, SECRET);

await sendTelegramPhoto(
  chatId,
  qrUrl,
  "🔐 *Secure EverOn Link QR*\n\n" +
    "• Only EverOn devices can use this QR\n" +
    "• QR expires automatically\n\n" +
    "After scanning, this chat will receive payment slips."
);

}

// --------------------
run().catch((err) => {
  console.error("Handler error:", err);
});
