const fs = require("fs");
const crypto = require("crypto");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function run() {
  const payload = JSON.parse(process.env.TG_PAYLOAD);
  const message = payload.message;
  const chatId = message.chat.id;
  const text = (message.text || "").trim().toUpperCase();

  const SECRET = process.env.REG_SECRET;

  // load license / registration JSON
  const data = JSON.parse(fs.readFileSync("license.json", "utf8"));

  const hash = sha256(text + SECRET);

  const match = data.find(r => r.reg_hash === hash);

  if (!match) {
    await sendTelegram(chatId, "❌ Invalid registration code.");
    return;
  }

  if (!match.chat_id) {
    match.chat_id = chatId;
    fs.writeFileSync("license.json", JSON.stringify(data, null, 2));
  }

  await sendTelegram(chatId, "✅ Registration successful.");
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

run();

