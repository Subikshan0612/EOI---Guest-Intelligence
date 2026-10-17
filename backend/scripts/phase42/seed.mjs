/**
 * Phase 42 - seed the base data of the user-perspective acceptance test through the REAL API (as the workspace admins), in the ISOLATED throwaway database.
 *
 *   P40_DIR=<dir with p40-state.json / p40.env> P42_API=http://localhost:5050/api node scripts/phase42/seed.mjs
 *
 * Creates: workspace A: one property, three units, a guest, a stay, three knowledge documents (chunked and embedded through the real pipeline) and ONE signal (the AC case);
 * workspace B: one property and one private signal (for the tenant-isolation checks). Every other signal of the test is created by the tester through the UI form.
 * Prints ids to the state file only (never the console). No secret is printed.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const DIR = process.env.P40_DIR; const API = process.env.P42_API;
const st = JSON.parse(fs.readFileSync(path.join(DIR, "p40-state.json"), "utf8"));
const envs = dotenv.parse(fs.readFileSync(path.join(DIR, "p40.env"), "utf8"));
process.env.NODE_ENV = "development";
const { signStubToken, STUB_ISSUER } = await import("../../src/auth/stubTokenVerifier.js");
const tok = (k) => signStubToken({ iss: STUB_ISSUER, sub: st.users[k].subject, exp: Math.floor(Date.now() / 1000) + 3 * 3600 }, envs.AUTH_STUB_SECRET);
const call = async (m, u, who, body) => { const r = await fetch(`${API}${u}`, { method: m, headers: { "content-type": "application/json", authorization: `Bearer ${tok(who)}` }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, d: j?.data }; };
const must = (label, r, ok = 201) => { if (r.status !== ok) { console.error(`seed step failed: ${label} (${r.status})`); process.exit(1); } console.log(`ok  ${label}`); return r; };
const A = st.wsA; const B = st.wsB;
const prop = must("property A", await call("POST", "/properties", "adminA", { workspaceId: A, name: "P42 Residency", code: "P42A" }));
const units = {};
for (const n of ["204", "305", "101"]) units[n] = String(must(`unit ${n}`, await call("POST", "/units", "adminA", { workspaceId: A, propertyId: prop.d._id, unitNumber: n })).d._id);
const guest = must("guest", await call("POST", "/guests", "adminA", { workspaceId: A, propertyId: prop.d._id, firstName: "Synthetic", lastName: "Guest" }));
const stay = must("stay", await call("POST", "/stays", "adminA", { workspaceId: A, guestId: guest.d._id, propertyId: prop.d._id, unitId: units["204"], checkIn: new Date(Date.now() - 86400000).toISOString(), checkOut: new Date(Date.now() + 2 * 86400000).toISOString(), status: "checked_in" }));
const docs = [
  { title: "AC Not Cooling - Maintenance Procedure", documentType: "procedure", propertyId: prop.d._id, defaultVisibility: "guest", content: "# Air conditioner not cooling\n\nWhen a guest reports that the air conditioner in an apartment is not cooling or is blowing warm air, dispatch a maintenance technician to inspect the unit within four hours.\n\n## First checks\n\nConfirm the thermostat is set to cool and the filters are clean. Record the room temperature reported by the guest.\n\n## Escalation\n\nIf the unit cannot be repaired the same day, offer the guest a portable fan or move them to another apartment." },
  { title: "Gas Smell and Smoke - Emergency Procedure", documentType: "sop", defaultVisibility: "staff", content: "# Gas smell, smoke, fire or carbon monoxide\n\nA report of a gas smell, smoke, fire or carbon monoxide is a life-safety emergency. Escalate to the emergency services and the duty manager immediately.\n\n## Do not\n\nDo not send maintenance staff into the unit. Do not ventilate or switch anything on or off. Evacuate the guest from the area.\n\n## After\n\nRecord the time of the report and who was informed." },
  { title: "Guest Refuses Entry - Access Policy", documentType: "policy", propertyId: prop.d._id, defaultVisibility: "guest", content: "# Guest refuses entry\n\nWhen a guest refuses entry to housekeeping or maintenance, staff must not enter the apartment. Do not dispatch maintenance to enter the unit without the guest's consent.\n\n## Next steps\n\nRecord the refusal, offer another time slot to the guest, and inform the duty manager if the issue affects safety." },
];
for (const d of docs) {
  const c = must(`knowledge "${d.title}"`, await call("POST", "/knowledge-documents", "adminA", { workspaceId: A, ...d, isTestData: true }));
  must("  chunked", await call("POST", `/knowledge-documents/${c.d._id}/chunks?workspaceId=${A}`, "adminA"));
  must("  embedded", await call("POST", `/knowledge-documents/${c.d._id}/embeddings?workspaceId=${A}`, "adminA"));
}
const sigA = must("signal (AC, unit 204)", await call("POST", "/signals", "adminA", { workspaceId: A, propertyId: prop.d._id, unitId: units["204"], guestId: guest.d._id, stayId: stay.d._id, type: "maintenance", severity: "medium", source: "staff", title: "Air conditioner in Unit 204 is showing repeated cooling issues", description: "The guest reports that the air conditioner in Unit 204 keeps failing to cool the room. It has been blowing warm air since this morning." }));
const propB = must("property B", await call("POST", "/properties", "adminB", { workspaceId: B, name: "P42 B Residency", code: "P42B" }));
const sigB = must("signal B (other tenant)", await call("POST", "/signals", "adminB", { workspaceId: B, propertyId: propB.d._id, type: "maintenance", severity: "medium", title: "Tenant B private signal", description: "TENANT-B-PRIVATE-MARKER" }));
st.ids = { propA: prop.d._id, units, guest: guest.d._id, stay: stay.d._id, sigA: sigA.d._id, sigBforeign: sigB.d._id, propB: propB.d._id };
fs.writeFileSync(path.join(DIR, "p40-state.json"), JSON.stringify(st, null, 1));
console.log("seed complete");
