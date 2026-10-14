/**
 * Phase 40 - a transparent local proxy between the Node backend and the Python AI service (loopback only).
 *
 *   node scripts/phase40/ai-proxy.mjs --listen 8001 --target 8000 --meta <file.jsonl>
 *
 * It forwards every request unchanged and records STRUCTURAL METADATA ONLY of each analysis call (counts, enum values, claim TYPES, evidence classes) to the
 * meta file - never a prompt, never any text of the Signal, the knowledge, the evidence or the model output. It is also the local fault injector: POST /__mode
 * {"mode": "..."} switches the next analysis calls to a failure so the failure tests can run WITHOUT any real provider call. Modes:
 *   pass (default) | down (connection reset) | malformed (200, not JSON) | timeout (never answers) | provider (502 provider error) |
 *   ratelimit (429) | unknownref (a valid answer whose claim cites an invented reference) | sourceless (a claim with no source) |
 *   canned (a fully valid canned answer: used only to prove recovery after a failure, no model involved)
 * Listens on 127.0.0.1 only. It never contacts anything except the local AI service.
 */
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const LISTEN = Number(arg("--listen", "8001")); const TARGET = Number(arg("--target", "8000")); const META = arg("--meta");
const state = { mode: "pass", analyzeCalls: 0 };
const counts = (list, keyOf) => { const out = {}; for (const x of Array.isArray(list) ? list : []) { const k = keyOf(x); if (typeof k === "string") out[k] = (out[k] ?? 0) + 1; } return out; };
const meta = (obj) => { if (META) fs.appendFileSync(META, JSON.stringify({ at: new Date().toISOString(), ...obj }) + "\n"); };

http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url === "/__mode" && req.method === "POST") { try { state.mode = JSON.parse(body.toString()).mode; } catch { /* keep */ } res.end(JSON.stringify({ mode: state.mode })); return; }
    if (req.url === "/__stats") { res.end(JSON.stringify(state)); return; }
    const isAnalyze = req.url === "/v1/intelligence/analyze";
    let parsed = {}; if (isAnalyze) { try { parsed = JSON.parse(body.toString()); } catch { parsed = {}; } }
    const send = (status, payload, raw) => { res.writeHead(status, { "content-type": "application/json" }); res.end(raw ?? JSON.stringify(payload)); };
    if (isAnalyze) {
      state.analyzeCalls += 1;
      meta({ kind: "analyze-request", mode: state.mode, level: parsed.authorizedLevel ?? null, knowledgeItems: (parsed.knowledge ?? []).length, historyItems: (parsed.operationalHistory?.items ?? parsed.operationalHistory ?? []).length ?? null, signalSeverity: parsed.context?.signal?.severity ?? null, signalType: parsed.context?.signal?.type ?? null, hasUnit: Boolean(parsed.context?.unit), hasProperty: Boolean(parsed.context?.property), hasGuest: Boolean(parsed.context?.guest), hasLearning: Boolean(parsed.learning) });
      const sid = parsed.context?.signal?.id;
      const valid = (claims) => ({ situation: "S", evidence: ["E"], impact: "I", recommendation: "Have the unit checked.", confidence: "medium", usedKnowledgeChunkIds: [], provenance: { provider: "gemini", model: "gemini-3.1-flash-lite" }, evidenceRefs: [], contradictions: [], urgency: "prompt", recommendedActionType: "inspection", claims });
      if (state.mode === "down") { req.socket.destroy(); return; }
      if (state.mode === "timeout") return; // never answers
      if (state.mode === "malformed") return send(200, null, "<<< not json >>>");
      if (state.mode === "provider") return send(502, { error: { code: "PROVIDER_ERROR", message: "provider failed" } });
      if (state.mode === "ratelimit") return send(429, { error: { code: "PROVIDER_RATE_LIMITED", message: "slow down" } });
      if (state.mode === "unknownref") return send(200, valid([{ claimType: "FACT", text: "f", sourceRefs: ["current:signal:64b00000000000000000ffff"] }, { claimType: "RECOMMENDATION", text: "r", sourceRefs: [`current:signal:${sid}`] }]));
      if (state.mode === "sourceless") return send(200, valid([{ claimType: "FACT", text: "f", sourceRefs: [] }, { claimType: "RECOMMENDATION", text: "r", sourceRefs: [`current:signal:${sid}`] }]));
      if (state.mode === "canned") return send(200, valid([{ claimType: "FACT", text: "f", sourceRefs: [`current:signal:${sid}`] }, { claimType: "RECOMMENDATION", text: "r", sourceRefs: [`current:signal:${sid}`] }]));
    }
    const up = http.request({ host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${TARGET}` } }, (r) => {
      const out = []; r.on("data", (c) => out.push(c));
      r.on("end", () => {
        const buf = Buffer.concat(out);
        if (isAnalyze) {
          let j = null; try { j = JSON.parse(buf.toString()); } catch { j = null; }
          meta({ kind: "analyze-response", status: r.statusCode, ...(j && !j.error ? { urgency: j.urgency ?? null, recommendedActionType: j.recommendedActionType ?? null, modelConfidence: j.confidence ?? null, claimTypes: counts(j.claims, (c) => c?.claimType), sourceRefClasses: counts((j.claims ?? []).flatMap((c) => c?.sourceRefs ?? []), (r2) => (typeof r2 === "string" ? r2.split(":")[0] : null)), evidenceRefs: (j.evidenceRefs ?? []).length, usedKnowledgeChunks: (j.usedKnowledgeChunkIds ?? []).length, provenance: j.provenance ?? null, hasUnknownKeys: Object.keys(j).filter((k) => !["situation", "evidence", "impact", "recommendation", "confidence", "usedKnowledgeChunkIds", "provenance", "evidenceRefs", "contradictions", "claims", "urgency", "recommendedActionType"].includes(k)).length } : { errorCode: j?.error?.code ?? null }) });
        }
        res.writeHead(r.statusCode, r.headers); res.end(buf);
      });
    });
    up.on("error", () => send(502, { error: { code: "PROVIDER_UNAVAILABLE", message: "proxy upstream error" } }));
    up.end(body);
  });
}).listen(LISTEN, "127.0.0.1", () => console.log(`ai-proxy listening on 127.0.0.1:${LISTEN} -> 127.0.0.1:${TARGET}`));
