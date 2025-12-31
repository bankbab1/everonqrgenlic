const fs = require("fs");
const crypto = require("crypto");

// --------------------
// Helpers
// --------------------
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
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

// Standard register button (used everywhere)
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
  // Handle button click
  // --------------------
  if (payload.callback_query) {
    const cb = payload.callback_query;
    const chatId = cb.message.chat.id;

    if (cb.data === "REGISTER") {
      await sendTelegram(
        chatId,
        "🧾 Please send your *Registration Code*.\n\nExample:\nABC123XYZ",
        registerKeyboard()
      );
    }

    return;
  }

  const msg = payload.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const input = text.toUpperCase();

  // --------------------
  // /start command
  // --------------------
  if (input === "/START") {
    await sendTelegram(
      chatId,
      "👋 Welcome to EverOn Bot\n\nFor the Store Owner, Please register first.",
      registerKeyboard()
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
      "❌ Invalid registration code.\n\nFor the Store Owner, Please register first.",
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
      "⛔ This registration is not active.\nPlease contact EverOn support.",
      registerKeyboard()
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
        "⛔ This registration has expired.\nPlease renew your subscription.",
        registerKeyboard()
      );
      return;
    }
  }

  // --------------------
  // Prevent rebinding
  // --------------------
  if (
    match.telegram_chat_id &&
    match.telegram_chat_id !== chatId
  ) {
    await sendTelegram(
      chatId,
      "⚠️ This registration code is already linked to another Telegram chat.",
      registerKeyboard()
    );
    return;
  }

  // --------------------
  // First-time bind
  // --------------------
  if (!match.telegram_chat_id) {
    match.telegram_chat_id = chatId;
    match.telegram_bound_at = new Date().toISOString();

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  }

  // --------------------
  // Success
  // --------------------
  await sendTelegram(
    chatId,
    "✅ Registration successful.\n\nThis chat is now linked for EverOn notifications.",
    registerKeyboard()
  );
}

// --------------------
run().catch((err) => {
  console.error("Handler error:", err);
});
