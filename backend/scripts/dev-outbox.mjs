/**
 * Development helper (Phase 46): prints the one-time links the backend wrote to its DEVELOPMENT email outbox (KOI_EMAIL_TRANSPORT=outbox) - the stand-in for
 * email delivery, which this repository does not have in production. It only READS a git-ignored local file; nothing is sent anywhere.
 *
 *   node scripts/dev-outbox.mjs                     the latest link per address and kind
 *   node scripts/dev-outbox.mjs someone@example.com only that address
 *
 * KOI_EMAIL_OUTBOX_FILE (an absolute path) selects another file, as the backend does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const override = (process.env.KOI_EMAIL_OUTBOX_FILE ?? "").trim();
const file = override && path.isAbsolute(override) ? override : path.join(here, "..", ".dev-outbox", "outbox.jsonl");
if (!fs.existsSync(file)) {
  console.log("The development outbox is empty (no email has been 'sent' yet).");
  process.exit(0);
}
const only = (process.argv[2] ?? "").trim().toLowerCase();
const latest = new Map();
for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  try {
    const message = JSON.parse(line);
    if (only && String(message.to).toLowerCase() !== only) continue;
    latest.set(`${message.to}|${message.kind}`, message);
  } catch {
    /* ignore a partial line */
  }
}
for (const message of latest.values()) console.log(`${message.at}  ${message.to}  ${message.kind}\n  ${message.link}\n`);
