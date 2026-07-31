/**
 * Build guard: no browser code may talk to Arc's RPC directly.
 *
 * Arc returns 403 to any request carrying a browser Origin header. That is the
 * whole reason /api/rpc exists — and a single bare http() in the signer was
 * enough to break every swap while reads kept working, which made it look like
 * a wallet bug rather than a transport one. This makes that regression a build
 * failure instead of a silent one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const NEEDLE = "rpc.testnet.arc.network";

/** Each exemption is a place the URL is legitimately named, with the reason. */
const ALLOWED = [
  // The relay itself — this is the one process allowed to reach upstream.
  "app/api/rpc/route.ts",
  // Chain definition: viem needs a URL, and it is what we hand to wallets.
  "lib/contracts.ts",
  // Server-side routes have no Origin header, so no 403.
  "app/api/",
  // Node scripts run outside the browser entirely.
  "scripts/",
  // Prose in the privacy policy, describing what the app connects to.
  "app/privacy/",
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "out"]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) yield full;
  }
}

const offenders = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOWED.some((a) => rel.startsWith(a))) continue;
  const src = readFileSync(file, "utf8");
  if (!src.includes(NEEDLE)) continue;
  src.split("\n").forEach((line, i) => {
    if (line.includes(NEEDLE)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

if (offenders.length) {
  console.error("\n✗ Direct Arc RPC reference outside the allowed files:\n");
  for (const o of offenders) console.error("  " + o);
  console.error(
    "\nBrowser code must go through /api/rpc — a direct call 403s on the Origin\n" +
      "header and surfaces as a generic network error. Use browserTransport().\n",
  );
  process.exit(1);
}

console.log("✓ no direct Arc RPC references in browser code");
