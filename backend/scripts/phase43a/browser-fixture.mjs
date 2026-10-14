/**
 * Phase 43A - browser fixture. In the ISOLATED throwaway database only (koi_p40_e2e_*; refuses anything else) it
 *   1. generates a stored analysis for the seeded signal through the REAL pipeline with the deterministic TEST provider (no Gemini call), then
 *   2. rewrites the stored prose to what a real model does: repeat internal evidence references inside its sentences, using the REAL ids of this
 *      workspace (the signal, the stay, the knowledge chunks the analysis retrieved), so the browser has something genuine to hide, and
 *   3. proposes a Decision (a snapshot of that recommendation).
 *
 *   P40_DIR=<dir with p40-state.json / p40.env> node scripts/phase43a/browser-fixture.mjs
 */
import "../../src/config/mongoSafety.js"; // validation / rehearsal tool: loopback databases only
import fs from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

const DIR = process.env.P40_DIR;
const st = JSON.parse(fs.readFileSync(`${DIR}/p40-state.json`, "utf8"));
const envs = dotenv.parse(fs.readFileSync(`${DIR}/p40.env`, "utf8"));
if (!/koi_p40_e2e_\d+/.test(envs.MONGODB_URI) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(envs.MONGODB_URI)) { console.error("refusing: not the isolated throwaway database"); process.exit(2); }
process.env.NODE_ENV = "development";
const { signStubToken, STUB_ISSUER } = await import("../../src/auth/stubTokenVerifier.js");
const tok = signStubToken({ iss: STUB_ISSUER, sub: st.users.operatorA.subject, exp: Math.floor(Date.now() / 1000) + 3600 }, envs.AUTH_STUB_SECRET);
const call = async (method, url, body) => { const r = await fetch(`http://localhost:5000/api${url}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };

const gen = await call("POST", `/intelligence/analyze/${st.ids.sigA}?workspaceId=${st.wsA}`, { workspaceId: st.wsA });
console.log("analyze:", gen.status);
if (gen.status !== 200 && gen.status !== 201) { console.error(JSON.stringify(gen.json).slice(0, 400)); process.exit(1); }
const view = gen.json.data; const prov = view.knowledgeProvenance || [];
console.log("provenance sections:", prov.map((p) => p.section).join(" | "));
const chunk = (i) => prov[i]?.chunkId || prov[0]?.chunkId;
const S = st.ids.sigA; const STAY = st.ids.stay;
const analysis = {
  situation: `A maintenance report (untrusted:signal:${S}) says the air conditioner in unit 204 is blowing warm air, and the guest is currently checked in (current:stay:${STAY}).`,
  evidence: [
    `The signal text reports repeated cooling failures (untrusted:signal:${S}).`,
    `The linked stay is recorded as checked_in (current:stay:${STAY}), so the guest is in the apartment.`,
    `The "${prov[0]?.section || "maintenance"}" guidance applies (knowledge:${chunk(0)}); see also chunkId ${chunk(1)}.`,
  ],
  impact: `The guest has no cooling right now (current:stay:${STAY}); history:signal:${S} shows no earlier related report.`,
  recommendation: `Dispatch a maintenance technician within four hours as per knowledge:${chunk(0)}, and if the unit cannot be repaired offer a portable fan (knowledge:${chunk(1)}, current:stay:${STAY}).`,
  confidence: view.analysis.confidence,
};
await mongoose.connect(envs.MONGODB_URI);
const col = mongoose.connection.db.collection("intelligences");
const res = await col.updateOne({ _id: new mongoose.Types.ObjectId(view._id) }, { $set: { "analysis.situation": analysis.situation, "analysis.evidence": analysis.evidence, "analysis.impact": analysis.impact, "analysis.recommendation": analysis.recommendation } });
console.log("stored prose rewritten:", res.modifiedCount === 1);
await mongoose.disconnect();
const dec = await call("POST", `/decisions/propose/${view._id}?workspaceId=${st.wsA}`);
console.log("decision proposal:", dec.status, dec.status >= 400 ? JSON.stringify(dec.json).slice(0, 200) : "");
st.ids.intelligenceId = view._id; fs.writeFileSync(`${DIR}/p40-state.json`, JSON.stringify(st, null, 1));
