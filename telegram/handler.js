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
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function run() {
  if (!process.env.TG_PAYLOAD) return;

  const payload = JSON.parse(process.env.TG_PAYLOAD);
  const msg = payload.message;

  // ✅ Ignore non-text messages
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id; // supports private or group
  const input = msg.text.trim().toUpperCase();
  const SECRET = process.env.REG_SECRET;

  const hash = sha256(input + SECRET);

  const data = JSON.parse(fs.readFileSync("license.json", "utf8"));
  const match = data.find(r => r.reg_hash === hash);

  if (!match) {
    await sendTelegram(chatId, "❌ Invalid registration code.");
    return;
  }

  // 🔒 Prevent rebinding
  if (match.chat_id && match.chat_id !== chatId) {
    await sendTelegram(
      chatId,
      "⚠️ This registration code is already linked to another chat."
    );
    return;
  }

  if (!match.chat_id) {
    match.chat_id = chatId;
    fs.writeFileSync("license.json", JSON.stringify(data, null, 2));
  }

  await sendTelegram(chatId, "✅ Registration successful.");
}

run().catch(err => {
  console.error("Handler error:", err);
});
