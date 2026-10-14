// Phase 43A - prints whether the RAW API still carries internal references (counts only; no tokens or ids printed).
import fs from "node:fs";
import dotenv from "dotenv";

const DIR = process.env.P40_DIR;
const st = JSON.parse(fs.readFileSync(`${DIR}/p40-state.json`, "utf8"));
const envs = dotenv.parse(fs.readFileSync(`${DIR}/p40.env`, "utf8"));
process.env.NODE_ENV = "development";
const { signStubToken, STUB_ISSUER } = await import("../../src/auth/stubTokenVerifier.js");
const tok = signStubToken({ iss: STUB_ISSUER, sub: st.users.operatorA.subject, exp: Math.floor(Date.now() / 1000) + 3600 }, envs.AUTH_STUB_SECRET);
const get = async (u) => (await fetch(`http://localhost:5000/api${u}`, { headers: { authorization: `Bearer ${tok}` } })).json();
const RE = /\b(?:current|untrusted|history|knowledge|learning):[A-Za-z0-9_.-]+/g;
const count = (o) => (JSON.stringify(o).match(RE) || []).length;
const intel = await get(`/intelligence/${st.ids.intelligenceId}?workspaceId=${st.wsA}`);
const dash = await get(`/dashboard/signals/${st.ids.sigA}?workspaceId=${st.wsA}`);
const decs = await get(`/decisions?workspaceId=${st.wsA}`);
console.log("raw GET /intelligence/:id        refs in response:", count(intel.data.analysis));
console.log("raw GET /dashboard/signals/:id   refs in response:", count(dash.data.intelligence));
console.log("raw GET /decisions               refs in response:", count(decs.data));
console.log("sample raw recommendation:", intel.data.analysis.recommendation.replace(/[0-9a-f]{24}/g, "<id>"));
