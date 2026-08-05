/**
 * Telegram Bot API client.
 *
 * The token is read from the environment at call time and used only as the
 * request path to api.telegram.org. It is never logged, never returned in a
 * response body, and never placed anywhere a browser could see it.
 */
const API = "https://api.telegram.org";

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return t;
}

async function call<T = unknown>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) {
    // Telegram echoes the request on some errors; keep only the description so
    // nothing from the request body can reach a log.
    throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  }
  return json.result as T;
}

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

export const sendMessage = (
  chatId: number,
  text: string,
  keyboard?: InlineButton[][],
) =>
  call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });

export const editMessage = (
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineButton[][],
) =>
  call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });

export const answerCallback = (id: string, text?: string) =>
  call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });

export const getMe = () => call<{ username: string }>("getMe", {});

/**
 * Register the webhook. Called from a server route, never from a browser, so
 * the token never enters a URL bar, history, or referrer header.
 */
export const setWebhook = (url: string, secretToken: string) =>
  call("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });

export const deleteWebhook = () => call("deleteWebhook", { drop_pending_updates: false });

/**
 * Register the command list so Telegram autocompletes it. Descriptions say
 * plainly which commands need a tap to sign on the device, so the two modes are
 * distinguishable before anyone types anything.
 */
export const setMyCommands = (commands: { command: string; description: string }[]) =>
  call("setMyCommands", { commands });
