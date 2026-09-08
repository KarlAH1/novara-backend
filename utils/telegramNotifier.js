function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function escapeTelegramText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendTelegramAdminAlert(title, lines = []) {
  if (!isTelegramConfigured()) {
    return false;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const text = [title, ...lines.filter(Boolean)].map((line) => escapeTelegramText(line)).join("\n");

  try {
    const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    }, { timeoutMs: Number(process.env.TELEGRAM_TIMEOUT_MS || 6000) });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      console.error("Telegram admin alert failed:", response.status);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Telegram admin alert error:", error);
    return false;
  }
}
import { fetchWithTimeout } from "./fetchWithTimeout.js";
