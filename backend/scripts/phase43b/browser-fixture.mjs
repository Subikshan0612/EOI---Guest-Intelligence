/**
 * Phase 43B - browser fixture, ISOLATED throwaway database only (koi_p40_e2e_*; refuses anything else). No Gemini call.
 * Creates five signals through the real API (as the workspace admin), runs the REAL analysis pipeline for each with the deterministic TEST provider,
 * then replaces the stored prose with representative text of what the model returned in Phase 42/42.5 (it repeats internal references too, so the
 * Phase 43A guarantee is exercised on the same pages). The recorded severity is real data on the Signal; nothing else is structured.
 *
 *   P40_DIR=<dir with p40-state.json / p40.env> node scripts/phase43b/browser-fixture.mjs
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
const tokFor = (key) => signStubToken({ iss: STUB_ISSUER, sub: st.users[key].subject, exp: Math.floor(Date.now() / 1000) + 3600 }, envs.AUTH_STUB_SECRET);
const call = async (who, method, url, body) => { const r = await fetch(`http://localhost:5000/api${url}`, { method, headers: { authorization: `Bearer ${tokFor(who)}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const A = st.wsA;
const base = { workspaceId: A, propertyId: st.ids.propA, guestId: st.ids.guest, type: "maintenance", source: "staff" };
const refs = (sig, chunk) => ({ S: `untrusted:signal:${sig}`, STAY: `current:stay:${st.ids.stay}`, K: `knowledge:${chunk}` });

const SCENARIOS = [
  { key: "normal", existing: true, prose: null },
  { key: "critical_gas", severity: "critical", unit: "204", title: "Strong smell of gas in Unit 305", description: "The guest reports a strong smell of gas in the apartment and the kitchen is filling with smoke.",
    prose: (r) => ({ situation: `A strong gas smell is reported in unit 305 (${r.S}) for a guest who is checked in (${r.STAY}).`, evidence: [`The report describes a gas smell and smoke (${r.S}).`, `The emergency procedure applies (${r.K}).`], impact: "There is a risk to the guest's life and to the building.", recommendation: `Treat this as an immediate life-safety emergency. Escalate to the emergency services and the duty manager now, and evacuate the guest (${r.K}). Do not send maintenance staff into the unit.` }) },
  { key: "gas_medium", severity: "medium", unit: "305", title: "Guest mentions a gas smell", description: "The guest mentions that there may be a gas smell near the cooker.",
    prose: (r) => ({ situation: `A gas smell is reported (${r.S}).`, evidence: [`The report mentions a gas smell (${r.S}).`, `The emergency procedure applies (${r.K}).`], impact: "A possible life-safety hazard.", recommendation: `Treat this as an immediate life-safety emergency and escalate to the duty manager now (${r.K}).` }) },
  { key: "refusal", severity: "medium", unit: "101", title: "Guest refuses maintenance entry", description: "The guest refuses entry to the maintenance technician and asks for another time.",
    prose: (r) => ({ situation: `The guest has refused entry to maintenance (${r.S}).`, evidence: [`The signal records the refusal (${r.S}).`, `The access policy applies (${r.K}).`], impact: "The repair is delayed until the guest agrees.", recommendation: `Do not enter the apartment (${r.K}). Record the refusal, offer the guest another time slot, and inform the duty manager.` }) },
  { key: "refusal_hazard", severity: "critical", unit: "204", title: "Gas smell, guest refuses entry", description: "A strong smell of gas in the apartment. The guest refuses entry to staff.",
    prose: (r) => ({ situation: `A gas smell is reported and the guest refuses entry (${r.S}).`, evidence: [`The report describes a gas smell and a refusal of entry (${r.S}).`, `The emergency procedure applies (${r.K}).`], impact: "A life-safety hazard in a unit staff may not enter.", recommendation: `Treat this as an immediate life-safety emergency. Escalate to the emergency services and the duty manager now (${r.K}). Do not send maintenance staff into the apartment.` }) },
];

await mongoose.connect(envs.MONGODB_URI);
const col = mongoose.connection.db.collection("intelligences");
st.ids.scenarios = {};
for (const sc of SCENARIOS) {
  let sigId = st.ids.sigA;
  if (!sc.existing) {
    const c = await call("adminA", "POST", "/signals", { ...base, ...(sc.unit === "204" ? { stayId: st.ids.stay } : {}), unitId: st.ids.units[sc.unit], severity: sc.severity, title: sc.title, description: sc.description });
    if (c.status !== 201) { console.error(`signal ${sc.key}: ${c.status} ${JSON.stringify(c.json).slice(0, 200)}`); process.exit(1); }
    sigId = c.json.data._id;
  }
  const g = await call("operatorA", "POST", `/intelligence/analyze/${sigId}?workspaceId=${A}`, { workspaceId: A });
  if (![200, 201].includes(g.status)) { console.error(`analyze ${sc.key}: ${g.status} ${JSON.stringify(g.json).slice(0, 300)}`); process.exit(1); }
  const view = g.json.data; const chunk = view.knowledgeProvenance?.[0]?.chunkId || "";
  if (sc.prose) {
    // no retrieved knowledge for this signal -> no knowledge citation (never write an empty reference)
    const p = JSON.parse(JSON.stringify(sc.prose(refs(sigId, chunk))).replace(/ ?\(knowledge:\)/g, ""));
    await col.updateOne({ _id: new mongoose.Types.ObjectId(view._id) }, { $set: { "analysis.situation": p.situation, "analysis.evidence": p.evidence, "analysis.impact": p.impact, "analysis.recommendation": p.recommendation } });
  }
  st.ids.scenarios[sc.key] = { signalId: sigId, intelligenceId: view._id };
  console.log(`ok  ${sc.key} (${sc.severity || "medium"}) analyze ${g.status}; provenance sections: ${(view.knowledgeProvenance || []).length}`);
}
await mongoose.disconnect();
fs.writeFileSync(`${DIR}/p40-state.json`, JSON.stringify(st, null, 1));
console.log("fixture complete");
