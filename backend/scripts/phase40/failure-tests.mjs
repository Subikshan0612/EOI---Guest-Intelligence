/**
 * Phase 40 - LOCAL failure-handling acceptance tests (no real provider call is made: the local ai-proxy injects every AI failure and never forwards it).
 *
 *   P40_DIR=<dir> node scripts/phase40/failure-tests.mjs
 *
 * Expects the stack from the acceptance run: backend :5000 (AI_SERVICE_URL -> the proxy :8001), the proxy :8001, the AI service :8000, the isolated
 * database from p40-state.json. Also runs a second backend (:5003) behind a TCP forwarder to MongoDB to simulate a database outage and recovery.
 */
import "../../src/config/mongoSafety.js"; // validation / rehearsal tool: loopback databases only
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const DIR = process.env.P40_DIR;
const st = JSON.parse(fs.readFileSync(path.join(DIR, "p40-state.json"), "utf8"));
const envs = dotenv.parse(fs.readFileSync(path.join(DIR, "p40.env"), "utf8"));
process.env.NODE_ENV = "development";
const { signStubToken, STUB_ISSUER } = await import("../../src/auth/stubTokenVerifier.js");
const tok = (k) => signStubToken({ iss: STUB_ISSUER, sub: st.users[k].subject, exp: Math.floor(Date.now() / 1000) + 3600 }, envs.AUTH_STUB_SECRET);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; let failed = 0; const out = [];
const check = (name, ok, detail = "") => { out.push({ stage: "failures", name, ok: Boolean(ok), detail }); if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const call = async (base, method, url, who, body, timeoutMs = 60000) => {
  const ctl = AbortSignal.timeout(timeoutMs); const t0 = Date.now();
  try {
    const r = await fetch(`${base}${url}`, { method, signal: ctl, headers: { "content-type": "application/json", authorization: `Bearer ${tok(who)}` }, body: body ? JSON.stringify(body) : undefined });
    let j = null; let raw = ""; try { raw = await r.text(); j = JSON.parse(raw); } catch { /* not json */ }
    return { status: r.status, j, raw, ms: Date.now() - t0, code: j?.details?.code, rule: j?.details?.rule };
  } catch (e) { return { status: 0, error: e?.name, ms: Date.now() - t0, raw: "" }; }
};
const API = "http://localhost:5000/api"; const A = st.wsA;
await mongoose.connect(envs.MONGODB_URI); await import("../../src/models/index.js"); const M = mongoose.models;
const pyAnalyzeLines = () => (fs.readFileSync(path.join(DIR, "ai.log"), "utf8").match(/POST \/v1\/intelligence\/analyze/g) ?? []).length;
const proxyStats = async () => fetch("http://localhost:8001/__stats").then((r) => r.json()).catch(() => null);
const setMode = (mode) => fetch("http://localhost:8001/__mode", { method: "POST", body: JSON.stringify({ mode }) });
const mkSignal = async (n) => (await M.Signal.create({ workspaceId: A, propertyId: st.ids.propA, type: "maintenance", severity: "medium", title: `P40 failure test signal ${n}`, description: "synthetic failure-test signal" }))._id.toString();
const rotate = ["operatorA", "reviewerA", "reviewer2A", "adminA"]; let rot = 0;
const baseline = { pyCalls: pyAnalyzeLines(), intel: await M.Intelligence.countDocuments(), };

async function scenario(label, mode, expect) {
  const sid = await mkSignal(label);
  await setMode(mode);
  const before = (await proxyStats()).analyzeCalls; const pyBefore = pyAnalyzeLines(); const intelBefore = await M.Intelligence.countDocuments();
  const r = await call(API, "POST", `/intelligence/analyze/${sid}?workspaceId=${A}`, rotate[rot++ % rotate.length], undefined, 60000);
  await sleep(300);
  const after = (await proxyStats()).analyzeCalls;
  const row = await M.AnalysisAdmission.findOne({ workspaceId: A, signalId: sid }).lean();
  const stored = await M.Intelligence.countDocuments({ workspaceId: A, signalIds: sid });
  const ok = expect(r) && stored === 0 && (await M.Intelligence.countDocuments()) === intelBefore && row?.outcome === "rejected" && row.finalConfidence === undefined && after - before <= 1 && pyAnalyzeLines() === pyBefore;
  check(`F.${label} (${mode}): HTTP ${r.status}${r.code ? ` ${r.code}` : ""}${r.rule ? ` rule ${r.rule}` : ""} in ${r.ms} ms; no Intelligence persisted; audit row REJECTED (${row?.decidedAt}/${row?.failureClass ?? row?.reasonCode}); at most ONE attempt reached the proxy (no retry: ${after - before}); the real AI service received no call`, ok, `audit=${row?.outcome}`);
  // not stuck: a later request for the SAME signal is processed afresh (canned answer: no model involved)
  await setMode("canned");
  const again = await call(API, "POST", `/intelligence/analyze/${sid}?workspaceId=${A}`, rotate[rot++ % rotate.length]);
  check(`F.${label} recovery: the same signal can be analysed afterwards (single-flight is not stuck, no sticky failure): HTTP ${again.status}`, again.status === 201, `${again.status}`);
  await setMode("pass");
  return { r, row };
}
const leak = (r) => !/mongodb:\/\/|stack|node_modules|at .*\.js|AUTH_STUB|Bearer |GEMINI|apikey/i.test(r.raw ?? "");

console.log("\n# AI failure handling (injected locally; no provider is called)");
const a = await scenario("A-ai-down", "down", (r) => r.status === 502 && /UNREACHABLE|AI_SERVICE/.test(r.code ?? "")); check("F.A-ai-down the error body leaks nothing (no stack, path, key, URI)", leak(a.r));
const b = await scenario("B-malformed", "malformed", (r) => r.status === 502); check("F.B-malformed the error body leaks nothing", leak(b.r));
const d = await scenario("D-provider-error", "provider", (r) => r.status >= 502 && r.status <= 504);
const rl = await scenario("D2-provider-rate-limit", "ratelimit", (r) => r.status === 503 || r.status === 429 || r.status === 502);
const e = await scenario("E-invalid-evidence-ref", "unknownref", (r) => r.status === 502 && r.code === "CLAIM_VALIDATION_FAILED" && r.rule === "CLAIM_UNKNOWN_REF"); check("F.E the invalid evidence reference was rejected with the stable rule code and the audit row carries it", e.row?.ruleCode === "CLAIM_UNKNOWN_REF" && e.row?.decidedAt === "claims");
const f = await scenario("F-invalid-claim", "sourceless", (r) => r.status === 502 && r.code === "CLAIM_VALIDATION_FAILED" && r.rule === "CLAIM_MISSING_SOURCE_REFS"); check("F.F the sourceless claim was rejected with its rule code", f.row?.ruleCode === "CLAIM_MISSING_SOURCE_REFS");

console.log("\n# provider TIMEOUT (the proxy never answers; Node gives up at its own analysis timeout)");
{
  const sid = await mkSignal("C-timeout"); await setMode("timeout"); const before = (await proxyStats()).analyzeCalls;
  const r = await call(API, "POST", `/intelligence/analyze/${sid}?workspaceId=${A}`, "adminA", undefined, 60000);
  await sleep(300);
  const row = await M.AnalysisAdmission.findOne({ workspaceId: A, signalId: sid }).lean();
  check(`F.C-timeout HTTP ${r.status} ${r.code ?? ""} after ${r.ms} ms (bounded by the 25 s analysis timeout); one attempt only (no retry); nothing persisted; audit rejected as ${row?.failureClass}`,
    r.status === 504 && r.ms < 35000 && r.ms >= 20000 && (await proxyStats()).analyzeCalls - before === 1 && (await M.Intelligence.countDocuments({ workspaceId: A, signalIds: sid })) === 0 && row?.outcome === "rejected", `${r.ms} ms`);
  await setMode("canned");
  const again = await call(API, "POST", `/intelligence/analyze/${sid}?workspaceId=${A}`, "adminA"); check("F.C-timeout recovery: analysable again afterwards", again.status === 201, `${again.status}`);
  await setMode("pass");
}

console.log("\n# Python AI service completely unreachable (the proxy process is stopped)");
{
  const sid = await mkSignal("A2-unreachable");
  // stop the proxy by asking the OS for its pid (loopback listener on 8001 only)
  const { execSync } = await import("node:child_process");
  const pid = execSync("netstat -ano | findstr \":8001\" | findstr LISTENING", { encoding: "utf8" }).trim().split(/\s+/).pop();
  execSync(`taskkill /PID ${pid} /T /F`); await sleep(800);
  const r = await call(API, "POST", `/intelligence/analyze/${sid}?workspaceId=${A}`, "adminA");
  const row = await M.AnalysisAdmission.findOne({ workspaceId: A, signalId: sid }).lean();
  check(`F.A2 with NOTHING listening at the AI service address: HTTP ${r.status} ${r.code ?? ""}, no Intelligence, audit rejected (${row?.failureClass}), fast failure (${r.ms} ms), no fallback model`, r.status === 502 && (await M.Intelligence.countDocuments({ workspaceId: A, signalIds: sid })) === 0 && row?.outcome === "rejected" && r.ms < 10000);
  const health = await call(API, "GET", "/health", "adminA");
  check("F.A2 the backend itself stays healthy while the AI service is away (it degrades only the AI feature)", health.status === 200);
  const p = spawn(process.execPath, [path.join(here, "ai-proxy.mjs"), "--listen", "8001", "--target", "8000", "--meta", path.join(DIR, "p40-proxy-meta.jsonl")], { detached: true, stdio: "ignore" }); p.unref(); await sleep(1200);
  await setMode("canned"); const again = await call(API, "POST", `/intelligence/analyze/${sid}?workspaceId=${A}`, "adminA"); await setMode("pass");
  check("F.A2 recovery after the AI service returns: the same signal is analysable (no stuck single-flight)", again.status === 201, `${again.status}`);
}

console.log("\n# MongoDB outage and recovery (a second backend behind a TCP forwarder; the isolated database only)");
{
  const dbUrl = new URL(envs.MONGODB_URI); const target = { host: dbUrl.hostname, port: Number(dbUrl.port || 27017) };
  let accepting = true; const sockets = new Set();
  const fwd = net.createServer((c) => { if (!accepting) return c.destroy(); const u = net.connect(target); sockets.add(c); sockets.add(u); c.pipe(u); u.pipe(c); const done = () => { c.destroy(); u.destroy(); sockets.delete(c); sockets.delete(u); }; c.on("error", done); u.on("error", done); c.on("close", done); u.on("close", done); });
  await new Promise((r) => fwd.listen(27999, "127.0.0.1", r));
  const uri = envs.MONGODB_URI.replace(/mongodb:\/\/[^/]+\//, "mongodb://127.0.0.1:27999/") + "?serverSelectionTimeoutMS=4000&connectTimeoutMS=3000";
  const out2 = []; const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, NODE_ENV: "development", AUTH_PROVIDER: "stub", AUTH_STUB_SECRET: envs.AUTH_STUB_SECRET, MONGODB_URI: uri, LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://localhost:8001", CLIENT_URL: "http://localhost:5173", PORT: "5003" }, stdio: ["ignore", "pipe", "pipe"] });
  be.stdout.on("data", (x) => out2.push(String(x))); be.stderr.on("data", (x) => out2.push(String(x)));
  const B3 = "http://localhost:5003/api"; for (let i = 0; i < 40; i += 1) { if ((await call(B3, "GET", "/health", "adminA", undefined, 2000)).status === 200) break; await sleep(500); }
  const ok1 = await call(B3, "GET", `/signals?workspaceId=${A}`, "adminA");
  check("M.1 with MongoDB reachable the second backend serves normally", ok1.status === 200, `${ok1.status}`);
  accepting = false; for (const s of sockets) s.destroy(); sockets.clear(); await sleep(500);
  const down = await call(B3, "GET", `/signals?workspaceId=${A}`, "adminA", undefined, 40000);
  const downWrite = await call(B3, "POST", "/guests", "adminA", { workspaceId: A, propertyId: "64b000000000000000000001", firstName: "Should", lastName: "NotPersist" }, 40000);
  check(`M.2 with MongoDB DOWN a read fails cleanly (HTTP ${down.status}, ${down.ms} ms), never a success, with a generic message and no URI/credential/stack in the body`, down.status >= 500 && down.status < 600 && leak(down) && !/27999|27017|127\.0\.0\.1/.test(down.raw), `${down.status} ${down.j?.message ?? ""}`);
  check(`M.3 a WRITE during the outage fails cleanly (HTTP ${downWrite.status}) and nothing is persisted`, downWrite.status >= 500 && (await M.Guest.countDocuments({ lastName: "NotPersist" })) === 0, `${downWrite.status}`);
  accepting = true; let rec = null; for (let i = 0; i < 30 && !rec; i += 1) { const r = await call(B3, "GET", `/signals?workspaceId=${A}`, "adminA", undefined, 15000); if (r.status === 200) rec = r; else await sleep(1000); }
  check("M.4 the application RECOVERS by itself when MongoDB returns (no restart)", rec?.status === 200, rec ? "200" : "never recovered");
  check("M.5 the backend log of the outage contains no credential, URI or token", !/mongodb:\/\/|Bearer |AUTH_STUB_SECRET/.test(out2.join("")) && !out2.join("").includes(envs.AUTH_STUB_SECRET));
  be.kill(); fwd.close(); for (const s of sockets) s.destroy();
}
await mongoose.disconnect();
fs.appendFileSync(path.join(DIR, "p40-report.jsonl"), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(`\nFailure tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
