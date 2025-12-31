const fs = require("fs");
const crypto = require("crypto");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}

async function run() {
  if (!process.env.TG_PAYLOAD) return;

  const payload = JSON.parse(process.env.TG_PAYLOAD);
  const msg = payload.message;

  // Ignore non-text messages
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id; // private or group
  const input = msg.text.trim().toUpperCase();
  const SECRET = (process.env.REG_SECRET || "").trim().toUpperCase();

  if (!SECRET) {
    console.error("REG_SECRET missing");
    return;
  }

  const hash = sha256(input + SECRET);

  // ✅ Load registration.json
  const db = JSON.parse(
    fs.readFileSync("registration.json", "utf8")
  );

  const match = db.registrations.find(
    r => r.reg_hash === hash
  );

  if (!match) {
    await sendTelegram(chatId, "❌ Invalid registration code.");
    return;
  }

  // 🔒 Prevent rebinding to another chat
  if (
    match.telegram_chat_id &&
    match.telegram_chat_id !== chatId
  ) {
    await sendTelegram(
      chatId,
      "⚠️ This registration code is already linked to another chat."
    );
    return;
  }

  // ✅ First-time bind
  if (!match.telegram_chat_id) {
    match.telegram_chat_id = chatId;
    match.telegram_bound_at = new Date().toISOString();

    fs.writeFileSync(
      "registration.json",
      JSON.stringify(db, null, 2)
    );
  }

  await sendTelegram(
    chatId,
    "✅ Registration successful.\n\nThis chat is now linked for EverOn notifications."
  );
}

run().catch(err => {
  console.error("Handler error:", err);
});
