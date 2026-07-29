/**
 * Bot handlers — deliberately thin.
 *
 * Trading now lives in the Mini App, which signs on the user's device. The bot's
 * remaining jobs are: get people into the Mini App, explain self-custody before
 * they put money in, hand out referral links, and deliver notifications. Keeping
 * it this small is the point — a bot that cannot trade cannot be tricked into
 * trading.
 */
import { answerCallback, editMessage, getMe, sendMessage, type InlineButton } from "./telegram";
import { referralCount, upsertUser } from "./db";

const MINIAPP_URL = process.env.MINIAPP_URL ?? "https://onyx-dex.vercel.app/miniapp";

const openButton: InlineButton[][] = [
  [{ text: "📈 Open Onyx", web_app: { url: MINIAPP_URL } }],
  [{ text: "🤝 Referral", callback_data: "referral" }, { text: "❓ Help", callback_data: "help" }],
];

const WELCOME =
  "*Onyx* — the on-chain order book on Arc.\n\n" +
  "*This is self-custody.*\n" +
  "Your wallet is created and unlocked on your own device. Your password and " +
  "private key never reach our servers — we hold only an encrypted file we cannot open.\n\n" +
  "That means *nobody can recover your funds for you.* Your recovery phrase is the " +
  "only backup, and you are shown it once.\n\n" +
  "Tap below to open the app.";

export async function handleMessage(msg: {
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}) {
  const from = msg.from;
  if (!from) return;
  const text = (msg.text ?? "").trim();

  if (text.startsWith("/start")) {
    // /start <referrerId> — credited only on first contact.
    const payload = text.split(/\s+/)[1] ?? "";
    const referrer = /^\d+$/.test(payload) && Number(payload) !== from.id ? Number(payload) : undefined;
    await upsertUser(from.id, from.username, referrer);
    await sendMessage(msg.chat.id, WELCOME, openButton);
    return;
  }

  if (text.startsWith("/referral")) {
    await upsertUser(from.id, from.username);
    await sendReferral(msg.chat.id, from.id);
    return;
  }

  // Anything else: point back at the app rather than pretending to parse it.
  await sendMessage(msg.chat.id, "Everything happens in the app — tap below.", openButton);
}

export async function handleCallback(cb: {
  id: string;
  from: { id: number; username?: string };
  message?: { chat: { id: number }; message_id: number };
  data?: string;
}) {
  await answerCallback(cb.id);
  if (!cb.message) return;
  const { chat, message_id } = cb.message;

  if (cb.data === "referral") {
    await sendReferral(chat.id, cb.from.id);
    return;
  }
  if (cb.data === "help") {
    await editMessage(
      chat.id,
      message_id,
      "*Help*\n\n" +
        "Swaps, limit orders and TWAPs all happen inside the app, where your wallet " +
        "signs on this device.\n\n" +
        "You'll get a message here when a limit order fills or a price alert triggers.\n\n" +
        "_Testnet only. Not audited._",
      openButton,
    );
    return;
  }
}

async function sendReferral(chatId: number, telegramId: number) {
  const me = await getMe();
  const link = `https://t.me/${me.username}?start=${telegramId}`;
  const n = await referralCount(telegramId);
  await sendMessage(
    chatId,
    `*Your referral link*\n\n\`${link}\`\n\nReferred so far: *${n}*\n\n_Fee sharing is currently off._`,
    openButton,
  );
}
