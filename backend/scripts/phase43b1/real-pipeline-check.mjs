/**
 * Phase 43B.1 - the REAL Node -> Python (deterministic TEST provider, :8010 from scripts/start-test-stack.mjs) pipeline on an ISOLATED throwaway database.
 * No Gemini, no key. Shows what the persisted/returned `safety` looks like when the provider states no urgency or action type: state only, nothing fabricated.
 *
 *   node scripts/phase43b1/real-pipeline-check.mjs
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI; const DB = `koi_p43b1_real_${Date.now()}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: not a plain loopback MongoDB"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB}`);
const { createActor } = await import("../lib/authFixtures.mjs");
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../../src/config/database.js");
const { Signal, Workspace, Intelligence } = await import("../../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB) { console.error("refusing: not the isolated database"); process.exit(2); }
const ws = await Workspace.create({ name: "P43B1 real", slug: `p43b1-real-${Date.now()}`, status: "active" });
const actor = await createActor({ role: "operator", workspaceId: ws._id, label: "p43b1-real" });
const PORT = 5090;
const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:8010", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" }, stdio: "ignore" });
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const call = async (method, url, body) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { "Content-Type": "application/json", ...actor.headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  for (const [label, severity, title, description] of [
    ["normal", "medium", "Air conditioner noisy", "The air conditioner is noisy."],
    ["critical", "critical", "Guest locked out", "The guest is locked out of the apartment."],
    ["hazard", "medium", "Smell of gas", "The guest reports a strong smell of gas in the kitchen."],
    ["refusal+hazard", "critical", "Gas smell, guest refuses entry", "A strong smell of gas. The guest refuses entry to staff."],
  ]) {
    const s = await Signal.create({ workspaceId: ws._id, type: "maintenance", severity, title, description });
    const r = await call("POST", `/intelligence/analyze/${s._id}?workspaceId=${ws._id}`, { workspaceId: String(ws._id) });
    const stored = await Intelligence.findById(r.json?.data?._id).lean();
    console.log(`${label.padEnd(15)} HTTP ${r.status}  api safety=${JSON.stringify(r.json?.data?.safety)}  stored safety=${JSON.stringify(stored?.safety)}  provider-stated urgency/action: ${stored?.safety?.urgency ?? "none"}/${stored?.safety?.recommendedActionType ?? "none"}`);
  }
} finally {
  child.kill();
  try { if (mongoose.connection.db.databaseName === DB) await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
  console.log(`isolated database ${DB} dropped`);
}
