export async function sendTelegram(config, text, { dryRun = false } = {}) {
  if (!config.notifications.telegramEnabled) {
    return { sent: false, reason: "disabled" };
  }
  const token = config.secrets.telegramBotToken;
  const chatId = config.secrets.telegramChatId;
  if (!token || !chatId) {
    return { sent: false, reason: "credentials_missing" };
  }
  if (dryRun) return { sent: false, reason: "dry_run", preview: text };

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Telegram Bot API returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok) throw new Error("Telegram Bot API rejected the message");
  return { sent: true, messageId: payload.result?.message_id ?? null };
}
