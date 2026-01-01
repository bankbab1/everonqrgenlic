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

  return (
    "https://api.qrserver.com/v1/create-qr-code/?" +
    "size=360x360&data=" +
    encodeURIComponent(deepLink)
  );
}

// --------------------
// Telegram helpers
// --------------------
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

  if (keyboard) body.reply_markup = keyboard;

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

// --------------------
// Keyboards
// --------------------
function registerKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔐 Register", callback_data: "REGISTER" }],
    ],
  };
}

function registeredKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔄 Re-generate Device QR", callback_data: "REGEN_QR" }],
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

  // ====================================================
  // 1️⃣ GITHUB → SEND TEST
  // ====================================================
  if (payload.type === "SEND_TEST") {
    const chatId = payload.chat_id;
    if (!chatId) return;

    await sendTelegram(
      chatId,
      "🧪 *EverOn Test Payment Slip*\n\n" +
        "✅ Telegram connection is working correctly.\n\n" +
        "You will receive real payment slips here."
    );
    return;
  }

  // ====================================================
  // 2️⃣ GITHUB → SEND SLIP IMAGE
  // ====================================================
  if (payload.type === "SEND_SLIP") {
    const { chat_id, image_base64, meta } = payload;
    if (!chat_id || !image_base64) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    const buffer = Buffer.from(image_base64, "base64");

    const caption =
      "🧾 *Payment Slip Received*\n\n" +
      `🏦 Bank: ${meta?.bank ?? "-"}\n` +
      `🔢 Ref: ${meta?.ref ?? "-"}\n` +
      `💰 Amount: ${meta?.amount ?? "-"}`;

    const form = new FormData();
    form.append("chat_id", chat_id);
    form.append("caption", caption);
    form.append("parse_mode", "Markdown");
    form.append("photo", buffer, {
      filename: "payment_slip.jpg",
      contentType: "image/jpeg",
    });

    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
    });

    console.log("✅ Payment slip sent");
    return;
  }

  // ====================================================
  // 3️⃣ TELEGRAM MESSAGE HANDLING
  // ====================================================
  const dbPath = "registration.json";
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));

  let chatId = null;
  if (payload.message?.chat?.id) {
    chatId = payload.message.chat.id;
  } else if (payload.callback_query?.message?.chat?.id) {
    chatId = payload.callback_query.message.chat.id;
  } else {
    return;
  }

  const alreadyRegistered = db.registrations.find(
    (r) => r.telegram_chat_id === chatId
  );

  // ----------------------------------------------------
  // Callback buttons
  // ----------------------------------------------------
  if (payload.callback_query) {
    const action = payload.callback_query.data;

    if (action === "REGISTER") {
      if (alreadyRegistered) {
        await sendTelegram(
          chatId,
          "✅ This chat is already registered.\n\n" +
            "If you changed device, re-generate a new QR below.",
          registeredKeyboard()
        );
      } else {
        await sendTelegram(
          chatId,
          "🧾 Please send your *Registration Code*.\n\nExample:\nABC123XYZ"
        );
      }
      return;
    }

    if (action === "REGEN_QR") {
      if (!alreadyRegistered) {
        await sendTelegram(chatId, "❌ This chat is not registered yet.");
        return;
      }

      const qrUrl = buildEveronQRUrl(chatId, SECRET);

      await sendTelegramPhoto(
        chatId,
        qrUrl,
        "🔐 *New EverOn Link QR*\n\n" +
          "• Valid for 10 minutes\n" +
          "• Old QR codes are automatically invalid"
      );
      return;
    }
  }

  // ----------------------------------------------------
  // Text messages
  // ----------------------------------------------------
  const msg = payload.message;
  if (!msg?.text) return;

  const input = msg.text.trim().toUpperCase();

  // /start
  if (input === "/START") {
    if (alreadyRegistered) {
      await sendTelegram(
        chatId,
        "✅ This chat is already registered.\n\n" +
          "Use the button below if you need a new device QR.",
        registeredKeyboard()
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

  if (alreadyRegistered) {
    await sendTelegram(
      chatId,
      "ℹ️ This chat is already registered.\n\n" +
        "Use *Re-generate Device QR* if you changed device.",
      registeredKeyboard()
    );
    return;
  }

  // ----------------------------------------------------
  // Registration code flow
  // ----------------------------------------------------
  const hash = sha256(input + SECRET);
  const match = db.registrations.find((r) => r.reg_hash === hash);

  if (!match) {
    await sendTelegram(
      chatId,
      "❌ Invalid registration code.\n\nPlease try again.",
      registerKeyboard()
    );
    return;
  }

  if (match.status !== "active") {
    await sendTelegram(
      chatId,
      "⛔ This registration is not active.\nPlease contact EverOn support."
    );
    return;
  }

  if (match.valid_until && new Date() > new Date(match.valid_until)) {
    await sendTelegram(
      chatId,
      "⛔ This registration has expired.\nPlease renew your subscription."
    );
    return;
  }

  if (match.telegram_chat_id && match.telegram_chat_id !== chatId) {
    await sendTelegram(
      chatId,
      "⚠️ This registration code is already linked to another Telegram chat."
    );
    return;
  }

  // Bind chat
  match.telegram_chat_id = chatId;
  match.telegram_bound_at = new Date().toISOString();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

  // Send initial QR
  await sendTelegram(
    chatId,
    "✅ *Registration successful*\n\n" +
      "📲 Open your *EverOn device* → Payment Slip → Scan QR"
  );

  const qrUrl = buildEveronQRUrl(chatId, SECRET);
  await sendTelegramPhoto(
    chatId,
    qrUrl,
    "🔐 *Secure EverOn Link QR*\n\n" +
      "• Valid for 10 minutes\n" +
      "• Only EverOn devices can use this QR"
  );
}

// --------------------
run().catch((err) => {
  console.error("Handler error:", err);
});
