// Telegram alerts — pushes to your phone even when the site is closed, because
// the server's scan loop runs regardless. Dormant without TELEGRAM_* env.
//
// Fired on: net crossing the alert threshold (new crossings only), a coin's
// deposit/withdraw gate going down, and execution errors. Per-key cooldown so
// a coin hovering at the threshold doesn't spam.

const COOLDOWN_MS = 5 * 60_000;

function cfg() {
  return { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
}
export function telegramConfigured(): boolean {
  const c = cfg();
  return !!(c.token && c.chat);
}

const g = globalThis as unknown as { __arbTgSent?: Map<string, number> };
g.__arbTgSent ??= new Map();

async function send(text: string): Promise<void> {
  const { token, chat } = cfg();
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best-effort */
  }
}

/** Send `text`, but at most once per `key` within the cooldown window. */
export async function notify(key: string, text: string): Promise<void> {
  if (!telegramConfigured()) return;
  const last = g.__arbTgSent!.get(key) ?? 0;
  const now = Date.now();
  if (now - last < COOLDOWN_MS) return;
  g.__arbTgSent!.set(key, now);
  await send(text);
}

/** Error/status pings (execution failures) — no cooldown, always delivered. */
export async function notifyNow(text: string): Promise<void> {
  await send(text);
}
