/**
 * Password strength — a hard gate, not advice.
 *
 * WHY THIS GOT STRICTER: the encrypted keystore now syncs through Telegram
 * CloudStorage so users don't lose wallets when they change phones. That trades
 * one threat for another. Before, an attacker needed the physical device. Now a
 * Telegram account takeover — phishing, SIM swap, a session the user forgot
 * about — hands them the encrypted blob. The password is then the ONLY thing
 * between them and the funds.
 *
 * So this rejects rather than warns, and it checks more than length. All checks
 * run locally: nothing about the password, not even a hash prefix, is ever sent
 * anywhere. That rules out breach-database lookups (which need a network call),
 * so we do the next best thing — reject the passwords that actually appear at
 * the top of breach corpora, plus the shapes people reach for when told "add a
 * number and a symbol".
 */

/**
 * The most common passwords across published breach corpora, plus crypto- and
 * Telegram-flavoured guesses an attacker targeting this app would try first.
 * Compact on purpose: this list stops the passwords that get guessed in the
 * first thousand attempts, which is where real account takeovers live.
 */
const COMMON = new Set([
  "password", "123456", "123456789", "12345678", "1234567890", "qwerty", "abc123",
  "111111", "123123", "admin", "letmein", "welcome", "monkey", "dragon", "sunshine",
  "princess", "football", "baseball", "iloveyou", "trustno1", "master", "hello",
  "freedom", "whatever", "qazwsx", "michael", "superman", "batman", "shadow",
  "passw0rd", "password1", "password123", "qwerty123", "1q2w3e4r", "zaq12wsx",
  "qwertyuiop", "asdfghjkl", "zxcvbnm", "1qaz2wsx", "iloveyou1", "starwars",
  "computer", "internet", "samsung", "google", "facebook", "telegram", "wallet",
  "bitcoin", "ethereum", "crypto", "satoshi", "blockchain", "metamask", "binance",
  "seedphrase", "privatekey", "myWallet", "cryptowallet", "walletpassword",
  "onyx", "arcnetwork", "usdc", "stablecoin", "trading", "moneymoney",
  "letmein123", "changeme", "secret", "test1234", "temp1234", "abcd1234",
  "aaaaaa", "000000", "654321", "121212", "112233", "789456", "159753",
  "mypassword", "newpassword", "strongpassword", "securepassword",
]);

/** Leet substitutions, so P@ssw0rd normalises down to password. */
function normalise(pw: string): string {
  return pw
    .toLowerCase()
    .replace(/[@]/g, "a")
    .replace(/[0]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[4]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[8]/g, "b")
    .replace(/[+]/g, "t");
}

/** Strip trailing digits/symbols people append: password2024! -> password */
const stripDecoration = (s: string) => s.replace(/[^a-z]+$/g, "").replace(/^[^a-z]+/g, "");

const KEYBOARD_RUNS = [
  "qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890",
  "abcdefghijklmnopqrstuvwxyz",
];

function hasLongRun(pw: string): boolean {
  const s = pw.toLowerCase();
  for (const row of KEYBOARD_RUNS) {
    for (let i = 0; i + 4 <= row.length; i++) {
      const run = row.slice(i, i + 4);
      if (s.includes(run) || s.includes([...run].reverse().join(""))) return true;
    }
  }
  return false;
}

function classCount(pw: string): number {
  return (
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^a-zA-Z0-9]/.test(pw))
  );
}

export type StrengthResult = { ok: true } | { ok: false; reason: string };

/**
 * Minimum 12 characters. Deliberately longer than the usual 8: this password
 * guards a key that now lives in a cloud account, and length is the only lever
 * that reliably beats offline cracking once someone has the blob.
 */
export const MIN_LENGTH = 12;

export function checkPasswordStrength(pw: string): StrengthResult {
  if (pw.length < MIN_LENGTH) {
    return { ok: false, reason: `Use at least ${MIN_LENGTH} characters — this one is ${pw.length}.` };
  }

  const norm = normalise(pw);
  const bare = stripDecoration(norm);

  if (COMMON.has(norm) || COMMON.has(bare)) {
    return {
      ok: false,
      reason: "That's one of the most commonly used passwords — it would be guessed early.",
    };
  }

  // Any single repeated character, or 4+ of the same in a row.
  if (/^(.)\1+$/.test(pw) || /(.)\1{3,}/.test(pw)) {
    return { ok: false, reason: "Too many repeated characters." };
  }

  if (hasLongRun(pw)) {
    return { ok: false, reason: "Avoid keyboard runs like qwerty or 1234." };
  }

  // All one character class is weak at any reasonable length.
  if (/^\d+$/.test(pw)) {
    return { ok: false, reason: "Digits alone are easy to crack — add letters." };
  }
  if (/^[a-zA-Z]+$/.test(pw) && pw.length < 16) {
    return { ok: false, reason: "Letters alone need to be much longer — add a digit or symbol." };
  }

  // Below 16 chars, demand variety. At 16+, a long passphrase is fine as-is.
  if (pw.length < 16 && classCount(pw) < 3) {
    return {
      ok: false,
      reason: "Mix upper case, lower case and digits — or use a longer passphrase (16+).",
    };
  }

  // A password that is mostly the app name is a targeted-guess candidate.
  if (/^(onyx|arc|telegram|flowbot)/i.test(bare) && pw.length < 20) {
    return { ok: false, reason: "Don't build it around the app's name — that's the first guess." };
  }

  return { ok: true };
}

/** Coarse indicator for the onboarding meter. Never gates on its own. */
export function strengthLabel(pw: string): { label: string; score: 0 | 1 | 2 | 3 } {
  if (pw.length === 0) return { label: "", score: 0 };
  const res = checkPasswordStrength(pw);
  if (!res.ok) return { label: "Too weak", score: 0 };
  if (pw.length >= 20 || (pw.length >= 16 && classCount(pw) >= 3)) {
    return { label: "Strong", score: 3 };
  }
  if (pw.length >= 14 && classCount(pw) >= 3) return { label: "Good", score: 2 };
  return { label: "Acceptable", score: 1 };
}
