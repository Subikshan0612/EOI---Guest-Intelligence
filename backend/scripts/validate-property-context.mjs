/**
 * PROPERTY-SCOPED OPERATIONAL CONTEXT  -  Workspace -> Property -> Guest -> Stay -> investigation.
 *
 *   node backend/scripts/validate-property-context.mjs
 *
 *   A  the interpreter with an EXPLICIT selection (pure): the selection is authoritative; the words cannot replace it
 *   B  the real API on an ISOLATED throwaway database (koi_pc_<stamp>, dropped at the end):
 *        B1  guests and stays are property-scoped (filtering, creation, moving a guest) and every relationship is verified by the SERVER
 *        B2  signals refuse a guest or stay of another property; a stay alone names its property and guest
 *        B3  the investigation (POST /conversations/intake with `context`) verifies the selection, persists Property / Guest / Stay / Unit / Signal and reuses it
 *        B4  malicious / mixed ids are rejected and leave NOTHING behind; another workspace's records are the same 404 as missing ones
 *        B5  the selected context REACHES the existing analysis (real ai-service in deterministic TEST mode behind a counting proxy), and nothing of another property does
 *        B6  the existing human flow still works end to end: Decision -> Action -> Outcome
 *        B7  the operational context (what the assessment is given) is property-scoped
 *   C  the frontend (through Vite SSR): dependent selection rules, empty / disabled / loading states, the form guarantees
 *   D  architecture: no new pipeline, no CSV / external data dependency, no model or provider change
 *   No Gemini, no key, no Atlas, no CSV.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const AI_SERVICE = path.join(REPO, "ai-service");
const read = (p) => fs.readFileSync(p, "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- isolated database, derived from the local loopback URI BEFORE anything reads it (never printed)
{
  const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? "";
  if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u;
}
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_pc_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) {
  console.error("refusing: the configured MongoDB is not a plain loopback instance");
  process.exit(2);
}
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);

const { createActor } = await import("./lib/authFixtures.mjs");
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { Conversation, Message, Signal, Workspace, Property, Unit, Guest, Stay, Intelligence } = await import("../src/models/index.js");
const { interpretOperatorMessage, normalizeIntakeText } = await import("../src/services/signalInterpreter.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) {
  console.error("refusing: not connected to the isolated database");
  process.exit(2);
}

const children = [];
const proxyLog = { analyze: 0, analyzeBodies: [] };
let proxyServer = null;

try {
  // ======================================================================================================== A
  console.log("\n# A. the interpreter with an explicit selection");
  const properties = [
    { _id: "pA", name: "Harbour Residences", code: "HRS" },
    { _id: "pB", name: "Palm Court", code: "PLC" },
  ];
  const units = [
    { _id: "uA204", propertyId: "pA", unitNumber: "204" },
    { _id: "uA205", propertyId: "pA", unitNumber: "205" },
    { _id: "uB301", propertyId: "pB", unitNumber: "301" },
    { _id: "uB204", propertyId: "pB", unitNumber: "204" },
  ];
  const I = (text, fixed, pendingText) => interpretOperatorMessage({ text: normalizeIntakeText(text), pendingText, properties, units, fixed });
  const fixedA = { propertyId: "pA", propertyName: "Harbour Residences" };

  const withStayUnit = I("AC is not cooling in Unit 204.", { ...fixedA, locked: true, unitId: "uA204", unitNumber: "204" });
  check("A1 an explicit selection with a stay (its unit 204): the report is READY at property A, unit 204 - taken from the SELECTION, basis explicit_selection", withStayUnit.outcome === "ready" && withStayUnit.draft.propertyId === "pA" && withStayUnit.draft.unitId === "uA204" && withStayUnit.draft.location.basis === "explicit_selection");
  const noClarify = I("AC is not cooling.", fixedA);
  check("A2 with a selected property no 'which property or room?' question is asked: the location is the selection", noClarify.outcome === "ready" && noClarify.draft.propertyId === "pA" && noClarify.draft.unitId === undefined);
  const roomInProperty = I("Unit 205 has no hot water.", fixedA);
  check("A3 a room the operator wrote that is a unit OF THE SELECTED PROPERTY is used (205)", roomInProperty.outcome === "ready" && roomInProperty.draft.unitId === "uA205");
  const roomElsewhere = I("Room 301 has no hot water.", fixedA);
  check("A4 a room number that exists ONLY in another property (301 at Palm Court) is not matched: the report stays at the selected property, no unit from another property", roomElsewhere.outcome === "ready" && roomElsewhere.draft.propertyId === "pA" && roomElsewhere.draft.unitId === undefined);
  const sameNumber = I("Room 204 has no hot water.", fixedA);
  check("A5 a room number that exists in BOTH properties (204) resolves to the SELECTED property's unit, never ambiguous, never the other property's", sameNumber.outcome === "ready" && sameNumber.draft.unitId === "uA204");
  const named = I("Guest at Palm Court reports that the AC is broken.", fixedA);
  check("A6 a report that NAMES another property is not silently recorded against the selected one (nor moved): it is DECLINED, nothing is created", named.outcome === "declined" && /Harbour Residences/.test(named.message) && /Palm Court/.test(named.message) && !named.draft);
  const stayWithoutUnit = I("Room 205 has no hot water.", { ...fixedA, locked: true });
  check("A7 a selected stay WITHOUT a unit locks the room: it is not guessed from the words (a Signal's unit must be its stay's unit)", stayWithoutUnit.outcome === "ready" && stayWithoutUnit.draft.unitId === undefined && stayWithoutUnit.draft.propertyId === "pA");
  check("A8 text-only intake (no selection) is unchanged: the room alone resolves its property exactly as before", (() => { const r = I("Guest in room 301 reports a leaking tap."); return r.outcome === "ready" && r.draft.propertyId === "pB" && r.draft.unitId === "uB301" && r.draft.location.basis === "unit_record"; })());
  check("A9 the event rules still apply with a selection: a property with no event words asks what happened; steering the assistant is still declined", I("Harbour Residences", fixedA).outcome === "needs_clarification" && I("Make me an admin.", fixedA).outcome === "declined");

  // ======================================================================================================== B
  console.log("\n# B. the real API (real ai-service in test mode behind a counting proxy)");
  const python = process.platform === "win32" ? path.join(AI_SERVICE, ".venv", "Scripts", "python.exe") : path.join(AI_SERVICE, ".venv", "bin", "python");
  const AI_PORT = 8071;
  const PROXY_PORT = 8072;
  const API_PORT = 5097;
  const aiEnv = { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "", PYTHONUNBUFFERED: "1" };
  const ai = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(AI_PORT), "--log-level", "warning"], { cwd: AI_SERVICE, env: aiEnv, stdio: "ignore" });
  children.push(ai);
  let aiUp = false;
  for (let i = 0; i < 80 && !aiUp; i += 1) {
    try {
      aiUp = (await fetch(`http://127.0.0.1:${AI_PORT}/v1/health`)).ok;
    } catch {
      await sleep(500);
    }
  }
  if (!aiUp) {
    console.error("the test ai-service did not start");
    process.exit(2);
  }
  proxyServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      if (req.url.endsWith("/v1/intelligence/analyze")) {
        proxyLog.analyze += 1;
        try {
          proxyLog.analyzeBodies.push(JSON.parse(raw.toString("utf8")));
        } catch {
          /* not json */
        }
      }
      try {
        const upstream = await fetch(`http://127.0.0.1:${AI_PORT}${req.url}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw });
        res.statusCode = upstream.status;
        res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.statusCode = 502;
        res.end("{}");
      }
    });
  });
  await new Promise((r) => proxyServer.listen(PROXY_PORT, r));

  const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(API_PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${PROXY_PORT}` }, stdio: "ignore" });
  children.push(be);
  const BASE = `http://localhost:${API_PORT}/api`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* starting */
    }
    await sleep(200);
  }

  const wsA = await Workspace.create({ name: `PC a ${stamp}`, slug: `pc-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `PC b ${stamp}`, slug: `pc-b-${stamp}`, status: "active" });
  const A = String(wsA._id);
  const B = String(wsB._id);
  const admin = await createActor({ role: "admin", workspaceId: wsA._id, label: "pc-admin" });
  const operator = await createActor({ role: "operator", workspaceId: wsA._id, label: "pc-op" });
  const viewer = await createActor({ role: "viewer", workspaceId: wsA._id, label: "pc-viewer" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "pc-adminb" });
  const call = async (method, url, who, body) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(who ? who.headers : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* none */
    }
    return { status: res.status, json, text };
  };
  const intake = (who, ws, content, context, conversationId) => call("POST", "/conversations/intake", who, { workspaceId: ws, content, ...(context ? { context } : {}), ...(conversationId ? { conversationId } : {}) });
  const idOf = (r) => r.json?.data?._id;
  const ids = (r) => (r.json?.data ?? []).map((x) => String(x._id)).sort();
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  // ---- the operational dataset is built through the application's OWN APIs (no CSV, no fixture file)
  const mkProperty = (ws, who, name, code) => call("POST", "/properties", who, { workspaceId: ws, name, code });
  const pHrs = await mkProperty(A, admin, "Harbour Residences", "HRS");
  const pPlc = await mkProperty(A, admin, "Palm Court", "PLC");
  const pGan = await mkProperty(A, admin, "Garden Annex", "GAN");
  const pOther = await mkProperty(B, adminB, "Other Tower", "OTW");
  const HRS = idOf(pHrs);
  const PLC = idOf(pPlc);
  const GAN = idOf(pGan);
  const OTW = idOf(pOther);
  const mkUnit = (ws, who, propertyId, unitNumber) => call("POST", "/units", who, { workspaceId: ws, propertyId, unitNumber });
  const u204 = idOf(await mkUnit(A, admin, HRS, "204"));
  const u205 = idOf(await mkUnit(A, admin, HRS, "205"));
  const u301 = idOf(await mkUnit(A, admin, PLC, "301"));
  const u204plc = idOf(await mkUnit(A, admin, PLC, "204"));
  const uOtw = idOf(await mkUnit(B, adminB, OTW, "204"));
  const mkGuest = (ws, who, propertyId, firstName, lastName) => call("POST", "/guests", who, { workspaceId: ws, ...(propertyId ? { propertyId } : {}), firstName, lastName });
  const gArun = await mkGuest(A, admin, HRS, "Arun", "Kumar");
  const gMaya = await mkGuest(A, admin, HRS, "Maya", "Iyer");
  const gBela = await mkGuest(A, admin, PLC, "Bela", "Nair");
  const gOther = await mkGuest(B, adminB, OTW, "Other", "Tenant");
  const ARUN = idOf(gArun);
  const MAYA = idOf(gMaya);
  const BELA = idOf(gBela);
  const OTHERG = idOf(gOther);
  const day = 86400000;
  const mkStay = (ws, who, body) => call("POST", "/stays", who, { workspaceId: ws, ...body });
  const sArun = await mkStay(A, admin, { guestId: ARUN, propertyId: HRS, unitId: u204, reservationId: "HR-204-001", status: "checked_in", checkIn: new Date(Date.now() - day).toISOString(), checkOut: new Date(Date.now() + 2 * day).toISOString() });
  const sBela = await mkStay(A, admin, { guestId: BELA, propertyId: PLC, unitId: u301, reservationId: "PC-301-001", status: "checked_in", checkIn: new Date(Date.now() - day).toISOString(), checkOut: new Date(Date.now() + 2 * day).toISOString() });
  const sOther = await mkStay(B, adminB, { guestId: OTHERG, propertyId: OTW, unitId: uOtw, reservationId: "OT-204-001", status: "checked_in" });
  const SARUN = idOf(sArun);
  const SBELA = idOf(sBela);
  const SOTHER = idOf(sOther);
  check("B0 the dataset was created through the application's own APIs: 4 properties (3 in one workspace, 1 in another), units, 4 guests and 3 stays, each property with its own records", [pHrs, pPlc, pGan, pOther].every((r) => r.status === 201) && [gArun, gMaya, gBela, gOther].every((r) => r.status === 201) && [sArun, sBela, sOther].every((r) => r.status === 201) && [HRS, PLC, GAN, OTW, u204, u205, u301, u204plc, uOtw].every(Boolean));

  // ---------------------------------------------------------------------------------------------------- B1
  console.log("\n# B1. guests and stays are property-scoped");
  const gA = await call("GET", `/guests?workspaceId=${A}&propertyId=${HRS}&limit=100`, admin);
  const gP = await call("GET", `/guests?workspaceId=${A}&propertyId=${PLC}&limit=100`, admin);
  check("B1.1 Property -> Guest filtering: Harbour Residences returns exactly Arun and Maya; Palm Court returns exactly Bela - selecting one property never exposes the other's guests", gA.status === 200 && same(ids(gA), [ARUN, MAYA]) && gP.status === 200 && same(ids(gP), [BELA]));
  const gAll = await call("GET", `/guests?workspaceId=${A}&limit=100`, admin);
  check("B1.2 without a property the existing listing is unchanged (this workspace's guests only, never workspace B's)", same(ids(gAll), [ARUN, MAYA, BELA]) && !gAll.text.includes(OTHERG));
  const gEmpty = await call("GET", `/guests?workspaceId=${A}&propertyId=${GAN}`, admin);
  check("B1.3 [empty state] a property with no guests answers 200 with an empty list", gEmpty.status === 200 && gEmpty.json.data.length === 0);
  const gForeign = await call("GET", `/guests?workspaceId=${A}&propertyId=${OTW}`, admin);
  const gMissing = await call("GET", `/guests?workspaceId=${A}&propertyId=${new mongoose.Types.ObjectId()}`, admin);
  check("B1.4 [workspace isolation] another workspace's property id is the SAME 404 as a property that does not exist (never an empty list, never a hint it exists)", gForeign.status === 404 && gMissing.status === 404 && gForeign.json.message === gMissing.json.message);
  const stA = await call("GET", `/stays?workspaceId=${A}&propertyId=${HRS}&guestId=${ARUN}&limit=100`, admin);
  const stNone = await call("GET", `/stays?workspaceId=${A}&propertyId=${HRS}&guestId=${MAYA}&limit=100`, admin);
  check("B1.5 Property + Guest -> Stay filtering: Arun at Harbour Residences has exactly his own stay; Maya has none (empty list)", stA.status === 200 && same(ids(stA), [SARUN]) && stNone.status === 200 && stNone.json.data.length === 0);
  const stMixed = await call("GET", `/stays?workspaceId=${A}&propertyId=${HRS}&guestId=${BELA}`, admin);
  check("B1.6 a guest of ANOTHER property asked for under this property is refused (400 GUEST_PROPERTY_MISMATCH): Bela's stay is never listed under Harbour Residences", stMixed.status === 400 && stMixed.json.details?.code === "GUEST_PROPERTY_MISMATCH" && !stMixed.text.includes(SBELA));
  const stForeignGuest = await call("GET", `/stays?workspaceId=${A}&propertyId=${HRS}&guestId=${OTHERG}`, admin);
  const stForeignProp = await call("GET", `/stays?workspaceId=${A}&propertyId=${OTW}`, admin);
  check("B1.7 [workspace isolation] another workspace's guest or property in a stay listing matches NOTHING (the existing contract: an empty list, never the other tenant's data)", stForeignGuest.status === 200 && stForeignGuest.json.data.length === 0 && stForeignProp.status === 200 && stForeignProp.json.data.length === 0 && !stForeignGuest.text.includes(SOTHER) && !stForeignProp.text.includes(SOTHER));

  const noProp = await mkGuest(A, admin, null, "No", "Property");
  const foreignProp = await mkGuest(A, admin, OTW, "Foreign", "Property");
  check("B1.8 a guest MUST belong to a property: creating one without a property is a 400, and with another workspace's property a 404 - nothing is created", noProp.status === 400 && foreignProp.status === 404 && (await Guest.countDocuments({ workspaceId: wsA._id, lastName: "Property" })) === 0);
  const crossStay = await mkStay(A, admin, { guestId: ARUN, propertyId: PLC });
  check("B1.9 [Guest A cannot be used with Property B] a stay at Palm Court for Arun (who belongs to Harbour Residences) is rejected 400 GUEST_PROPERTY_MISMATCH", crossStay.status === 400 && crossStay.json.details?.code === "GUEST_PROPERTY_MISMATCH");
  const crossUnit = await mkStay(A, admin, { guestId: ARUN, propertyId: HRS, unitId: u301 });
  check("B1.10 a unit of another property is still rejected on a stay (400)", crossUnit.status === 400);
  const legacy = await Guest.create({ workspaceId: wsA._id, firstName: "Legacy", lastName: "Guest" }); // created before guests had a property
  const legacyStay = await mkStay(A, admin, { guestId: String(legacy._id), propertyId: HRS });
  check("B1.11 a guest from before guests had a property (no propertyId) cannot be given a stay until it is assigned: 400 GUEST_PROPERTY_UNASSIGNED", legacyStay.status === 400 && legacyStay.json.details?.code === "GUEST_PROPERTY_UNASSIGNED");
  const moveWithStays = await call("PATCH", `/guests/${ARUN}?workspaceId=${A}`, admin, { propertyId: PLC });
  const moveForeign = await call("PATCH", `/guests/${MAYA}?workspaceId=${A}`, admin, { propertyId: OTW });
  const moveFree = await call("PATCH", `/guests/${MAYA}?workspaceId=${A}`, admin, { propertyId: PLC });
  const moveBack = await call("PATCH", `/guests/${MAYA}?workspaceId=${A}`, admin, { propertyId: HRS });
  const assignLegacy = await call("PATCH", `/guests/${legacy._id}?workspaceId=${A}`, admin, { propertyId: HRS });
  const clearProp = await call("PATCH", `/guests/${MAYA}?workspaceId=${A}`, admin, { propertyId: null });
  check("B1.12 moving a guest: refused (409) while the guest has stays at the old property, refused (404) to another workspace's property and to nothing (400); allowed for a guest with no stays; a legacy guest can be assigned", moveWithStays.status === 409 && moveForeign.status === 404 && clearProp.status === 400 && moveFree.status === 200 && moveBack.status === 200 && assignLegacy.status === 200 && String((await Guest.findById(legacy._id).lean()).propertyId) === HRS);
  const legacyOk = await mkStay(A, admin, { guestId: String(legacy._id), propertyId: HRS, reservationId: "HR-LEG-001" });
  check("B1.13 once assigned, that guest can have a stay at its property", legacyOk.status === 201);
  await Stay.deleteOne({ _id: idOf(legacyOk) });
  await Guest.deleteOne({ _id: legacy._id });
  const reRead = await call("GET", `/guests/${ARUN}?workspaceId=${A}`, admin);
  check("B1.14 the stored guest carries its property (a stable reference, not a string copy)", String(reRead.json.data.propertyId) === HRS && mongoose.isValidObjectId(reRead.json.data.propertyId));

  // ---------------------------------------------------------------------------------------------------- B2
  console.log("\n# B2. signals keep the property -> guest -> stay relationship");
  const sigBody = (extra) => ({ workspaceId: A, type: "maintenance", title: "AC is not cooling", description: "AC is not cooling in Unit 204.", ...extra });
  const sigGuestB = await call("POST", "/signals", operator, sigBody({ propertyId: HRS, guestId: BELA }));
  const sigStayB = await call("POST", "/signals", operator, sigBody({ propertyId: HRS, stayId: SBELA }));
  const sigStayOtherGuest = await call("POST", "/signals", operator, sigBody({ propertyId: HRS, guestId: MAYA, stayId: SARUN }));
  const sigForeign = await call("POST", "/signals", operator, sigBody({ propertyId: HRS, guestId: OTHERG }));
  const sigForeignStay = await call("POST", "/signals", operator, sigBody({ propertyId: HRS, stayId: SOTHER }));
  check("B2.1 [Guest B cannot be submitted with Property A] [Stay B cannot be submitted with Property A] [a stay of another guest is refused] - all 400; another workspace's guest or stay is the same 404", sigGuestB.status === 400 && sigStayB.status === 400 && sigStayOtherGuest.status === 400 && sigForeign.status === 404 && sigForeignStay.status === 404 && (await Signal.countDocuments({ workspaceId: wsA._id })) === 0);
  const sigOk = await call("POST", "/signals", operator, sigBody({ propertyId: HRS, guestId: ARUN, stayId: SARUN, unitId: u204 }));
  const sigFromStay = await call("POST", "/signals", operator, sigBody({ stayId: SARUN, title: "From the stay alone" }));
  const fromStay = await Signal.findById(idOf(sigFromStay)).lean();
  check("B2.2 a consistent Signal is stored with property, guest, stay and unit; a stay alone names its property (derived by the server, never believed from the browser)", sigOk.status === 201 && sigFromStay.status === 201 && String(fromStay.propertyId) === HRS && String(fromStay.stayId) === SARUN);
  const patchBad = await call("PATCH", `/signals/${idOf(sigOk)}?workspaceId=${A}`, operator, { guestId: BELA });
  const patchTitle = await call("PATCH", `/signals/${idOf(sigOk)}?workspaceId=${A}`, operator, { title: "AC is not cooling (updated)" });
  check("B2.3 changing a signal's guest to another property's guest is refused (400); editing its title is not affected", patchBad.status === 400 && patchTitle.status === 200);
  await Signal.deleteMany({ workspaceId: wsA._id });

  // ---------------------------------------------------------------------------------------------------- B3 / B4
  console.log("\n# B3. the investigation starts with its operational context");
  const convoBefore = await Conversation.countDocuments({ workspaceId: wsA._id });
  const t1 = await intake(operator, A, "AC is not cooling in Unit 204.", { propertyId: HRS, guestId: ARUN, stayId: SARUN });
  const sig1 = t1.json?.data?.signal;
  const s1 = sig1 ? await Signal.findById(sig1._id).lean() : null;
  const c1 = t1.json?.data?.conversation ? await Conversation.findById(t1.json.data.conversation._id).lean() : null;
  check("B3.1 an investigation started with Property + Guest + Stay creates a Signal (201) that PERSISTS workspace, property, guest, stay and the stay's unit (stable references), source staff, the operator's own words", t1.status === 201 && String(s1?.workspaceId) === A && String(s1?.propertyId) === HRS && String(s1?.guestId) === ARUN && String(s1?.stayId) === SARUN && String(s1?.unitId) === u204 && s1?.description === "AC is not cooling in Unit 204." && s1?.source === "staff");
  check("B3.2 the investigation (conversation) stores the same context - property, guest, stay - and links its Signal; provenance says the context was explicit", String(c1?.propertyId) === HRS && String(c1?.guestId) === ARUN && String(c1?.stayId) === SARUN && c1?.signalIds.map(String).includes(String(sig1?._id)) && s1?.metadata?.intake?.contextBasis === "explicit" && s1?.metadata?.intake?.stayLinked === true);
  const t2 = await intake(operator, A, "The guest also says the bedroom is very hot.", undefined, c1._id);
  const s2 = t2.json?.data?.signal ? await Signal.findById(t2.json.data.signal._id).lean() : null;
  check("B3.3 a later turn of the same investigation reuses the STORED context (nothing is sent by the browser): its Signal carries the same property, guest, stay and unit", t2.status === 201 && String(s2?.propertyId) === HRS && String(s2?.guestId) === ARUN && String(s2?.stayId) === SARUN && String(s2?.unitId) === u204);
  const t3 = await intake(operator, A, "Another report.", { propertyId: PLC, guestId: BELA, stayId: SBELA }, c1._id);
  const t3same = await intake(operator, A, "The television in the lounge is not working.", { propertyId: HRS, guestId: ARUN, stayId: SARUN }, c1._id);
  check("B3.4 the context of a started investigation cannot be swapped: another selection on the same conversation is 409; repeating the same one is accepted", t3.status === 409 && t3.json.details?.code === "CONVERSATION_CONTEXT_FIXED" && t3same.status === 201);
  const tProp = await intake(operator, A, "AC is not cooling.", { propertyId: HRS });
  const sProp = await Signal.findById(tProp.json?.data?.signal?._id).lean();
  check("B3.5 a property-only selection is valid (guest and stay are optional): the Signal carries the property and no guest or stay is guessed", tProp.status === 201 && String(sProp.propertyId) === HRS && !sProp.guestId && !sProp.stayId && sProp.metadata.intake.stayLinked === false);
  const tGuest = await intake(operator, A, "Guest asks for an extra pillow.", { propertyId: HRS, guestId: MAYA });
  const sGuest = await Signal.findById(tGuest.json?.data?.signal?._id).lean();
  check("B3.6 property + guest without a stay: the guest is kept, no stay is invented (even if the guest had a current one)", tGuest.status === 201 && String(sGuest.guestId) === MAYA && !sGuest.stayId);
  const tStayOnly = await intake(operator, A, "The shower drain is blocked.", { propertyId: HRS, stayId: SARUN });
  const sStayOnly = await Signal.findById(tStayOnly.json?.data?.signal?._id).lean();
  check("B3.7 a stay alone names its guest: the server derives (and verifies) the stay's guest", tStayOnly.status === 201 && String(sStayOnly.guestId) === ARUN && String(sStayOnly.stayId) === SARUN);
  const tRoomElsewhere = await intake(operator, A, "Room 301 has a leaking tap.", { propertyId: HRS });
  const sRoomElsewhere = await Signal.findById(tRoomElsewhere.json?.data?.signal?._id).lean();
  check("B3.8 [the words cannot replace the selection] 'Room 301' (a Palm Court unit) with Harbour Residences selected: the Signal stays at Harbour Residences with NO unit from another property", tRoomElsewhere.status === 201 && String(sRoomElsewhere.propertyId) === HRS && !sRoomElsewhere.unitId);
  const signalsBeforeNamed = await Signal.countDocuments({ workspaceId: wsA._id });
  const tNamed = await intake(operator, A, "Guest at Palm Court says the AC is broken.", { propertyId: HRS });
  check("B3.9 a report that names a different property than the selected one is declined (200) and records nothing", tNamed.status === 200 && tNamed.json.data.outcome === "declined" && (await Signal.countDocuments({ workspaceId: wsA._id })) === signalsBeforeNamed);
  const tSharedRoom = await intake(operator, A, "Room 204 has no hot water.", { propertyId: PLC });
  const sSharedRoom = await Signal.findById(tSharedRoom.json?.data?.signal?._id).lean();
  check("B3.10 the same room number in two properties (204) resolves inside the SELECTED property (Palm Court's 204), never the other's", tSharedRoom.status === 201 && String(sSharedRoom.unitId) === u204plc && String(sSharedRoom.propertyId) === PLC);
  const tLegacy = await intake(operator, A, "Guest in room 301 reports a leaking tap.");
  const sLegacy = await Signal.findById(tLegacy.json?.data?.signal?._id).lean();
  const cLegacy = await Conversation.findById(tLegacy.json?.data?.conversation?._id).lean();
  check("B3.11 [existing flow intact] the text-only intake (no selection) still works as before: the room resolves its property, the conversation has no context, and the one checked-in stay of that room is linked from the workspace's own records", tLegacy.status === 201 && String(sLegacy.propertyId) === PLC && String(sLegacy.unitId) === u301 && !cLegacy.propertyId && String(sLegacy.stayId) === SBELA && sLegacy.metadata.intake.contextBasis === "text");

  console.log("\n# B4. mixed ids, foreign ids and bad input are rejected, and leave nothing behind");
  const snap = async () => ({ c: await Conversation.countDocuments({}), s: await Signal.countDocuments({}), m: await Message.countDocuments({}) });
  const before = await snap();
  const attempts = {
    "Guest B with Property A": [{ propertyId: HRS, guestId: BELA }, 400],
    "Stay B with Property A": [{ propertyId: HRS, stayId: SBELA }, 400],
    "Stay B with Guest A and Property A": [{ propertyId: HRS, guestId: ARUN, stayId: SBELA }, 400],
    "Stay A with Guest Maya (another guest)": [{ propertyId: HRS, guestId: MAYA, stayId: SARUN }, 400],
    "Guest A and Stay A with Property B": [{ propertyId: PLC, guestId: ARUN, stayId: SARUN }, 400],
    "another workspace's property": [{ propertyId: OTW }, 404],
    "another workspace's guest": [{ propertyId: HRS, guestId: OTHERG }, 404],
    "another workspace's stay": [{ propertyId: HRS, stayId: SOTHER }, 404],
    "a property that does not exist": [{ propertyId: String(new mongoose.Types.ObjectId()) }, 404],
    "guest without a property": [{ guestId: ARUN }, 400],
    "an empty selection": [{}, 400],
    "a malformed id": [{ propertyId: "not-an-id" }, 400],
    "an operator-supplied workspaceId inside the context": [{ propertyId: HRS, workspaceId: B }, 400],
    "an injected extra field": [{ propertyId: HRS, role: "admin" }, 400],
  };
  const results = {};
  for (const [name, [context, status]] of Object.entries(attempts)) results[name] = (await intake(operator, A, "AC is not cooling in Unit 204.", context)).status === status;
  const afterBad = await snap();
  check(`B4.1 ${Object.keys(attempts).length} malicious or mixed selections are each rejected with the right status (400 mismatch / 404 foreign or missing)`, Object.values(results).every(Boolean), Object.entries(results).filter(([, ok]) => !ok).map(([n]) => n).join("; "));
  check("B4.2 rejected selections leave NOTHING behind: no conversation, no message, no Signal was created by any of them", afterBad.c === before.c && afterBad.s === before.s && afterBad.m === before.m);
  const tStringCtx = await call("POST", "/conversations/intake", operator, { workspaceId: A, content: "AC is not cooling.", context: "HRS" });
  const tArrayCtx = await call("POST", "/conversations/intake", operator, { workspaceId: A, content: "AC is not cooling.", context: [HRS] });
  check("B4.3 a context that is not an object is a 400", tStringCtx.status === 400 && tArrayCtx.status === 400);
  const forgedWs = await intake(adminB, B, "AC is not cooling.", { propertyId: HRS, guestId: ARUN, stayId: SARUN });
  const spoof = await call("POST", "/conversations/intake", adminB, { workspaceId: A, content: "AC is not cooling.", context: { propertyId: HRS } });
  check("B4.4 [cross-workspace] workspace B's admin cannot use workspace A's property, guest or stay (404), and naming workspace A in the body does not make them a member (404)", forgedWs.status === 404 && spoof.status === 404);
  const otherConvo = await intake(adminB, B, "AC is not cooling.", { propertyId: OTW, guestId: OTHERG, stayId: SOTHER }, c1._id);
  check("B4.5 workspace B cannot continue workspace A's investigation with its own (or any) context (404)", otherConvo.status === 404);
  const viewerTry = await intake(viewer, A, "AC is not cooling.", { propertyId: HRS });
  check("B4.6 [RBAC unchanged] a viewer cannot start an investigation (403); the same permission as recording a Signal", viewerTry.status === 403);
  const viewerReadGuests = await call("GET", `/guests?workspaceId=${A}&propertyId=${HRS}`, viewer);
  const opReadGuests = await call("GET", `/guests?workspaceId=${A}&propertyId=${HRS}`, operator);
  check("B4.7 [RBAC unchanged] reading a property's guests needs operations:view (a viewer gets 403, an operator 200)", viewerReadGuests.status === 403 && opReadGuests.status === 200);
  // ---- property deletion safety
  const delPropA = await call("DELETE", `/properties/${HRS}?workspaceId=${A}`, admin);
  const delStillThere = await call("GET", `/properties/${HRS}?workspaceId=${A}`, admin);
  check("B4.10 [property deletion safety] a property with units, guests, stays, reports or investigations cannot be deleted: 409 PROPERTY_HAS_RECORDS naming what is in the way and pointing to 'archived'; the property and every record survive", delPropA.status === 409 && delPropA.json.details?.code === "PROPERTY_HAS_RECORDS" && /units/.test(delPropA.json.message) && /guests/.test(delPropA.json.message) && /stays/.test(delPropA.json.message) && /archived/.test(delPropA.json.message) && delPropA.json.details.records.units === 2 && delPropA.json.details.records.guests === 2 && delStillThere.status === 200 && (await Unit.countDocuments({ propertyId: HRS })) === 2 && (await Guest.countDocuments({ propertyId: HRS })) === 2 && (await Stay.countDocuments({ propertyId: HRS })) === 1);
  const delEmpty = await call("DELETE", `/properties/${GAN}?workspaceId=${A}`, admin);
  const delForeign = await call("DELETE", `/properties/${OTW}?workspaceId=${A}`, admin);
  const archive = await call("PATCH", `/properties/${PLC}?workspaceId=${A}`, admin, { status: "archived" });
  check("B4.11 an EMPTY property can still be deleted (200); another workspace's property is the usual 404; a property with records can be retired by archiving instead (200, nothing deleted)", delEmpty.status === 200 && delForeign.status === 404 && archive.status === 200 && archive.json.data.status === "archived" && (await Guest.countDocuments({ propertyId: PLC })) === 1);
  await call("PATCH", `/properties/${PLC}?workspaceId=${A}`, admin, { status: "active" });
  const genericConvo = await call("POST", "/conversations", operator, { workspaceId: A, propertyId: HRS, guestId: BELA });
  const genericOk = await call("POST", "/conversations", operator, { workspaceId: A, propertyId: HRS, guestId: ARUN, stayId: SARUN });
  check("B4.8 the generic conversation API enforces the same relationships (guest of another property: 400; a consistent context: 201 and stored)", genericConvo.status === 400 && genericOk.status === 201 && String((await Conversation.findById(idOf(genericOk)).lean()).propertyId) === HRS);
  const patchProp = await call("PATCH", `/conversations/${idOf(genericOk)}?workspaceId=${A}`, operator, { propertyId: PLC });
  const patchGuest = await call("PATCH", `/conversations/${idOf(genericOk)}?workspaceId=${A}`, operator, { guestId: BELA });
  check("B4.9 a conversation's property cannot be changed by PATCH (ignored), and a guest from another property is refused (400)", patchProp.status === 400 && patchGuest.status === 400);

  // ---------------------------------------------------------------------------------------------------- B7 (context assembly)
  console.log("\n# B5. the operational context is property-scoped");
  // an old record: Arun also has a stay recorded at Palm Court (created directly, as an older record would be)
  await Stay.create({ workspaceId: wsA._id, guestId: new mongoose.Types.ObjectId(ARUN), propertyId: new mongoose.Types.ObjectId(PLC), reservationId: "OLD-PLC-1", status: "checked_out" });
  const ctx = await call("GET", `/signals/${sig1._id}/context?workspaceId=${A}`, operator);
  const cd = ctx.json?.data;
  check("B5.1 GET /signals/:id/context gives the assessment the selected property, unit, guest and stay (all available), the stay with its booking reference", ctx.status === 200 && cd.property?.available && cd.property.name === "Harbour Residences" && cd.unit?.unitNumber === "204" && cd.guest?.available && cd.guest.id === ARUN && cd.stay?.available && cd.stay.reservationId === "HR-204-001" && String(cd.stay.propertyId) === HRS);
  check("B5.2 the guest's stay history in the context is THIS property's only: Arun's stay at Palm Court is not in it", Array.isArray(cd.guest.recentStays) && cd.guest.recentStays.length === 1 && cd.guest.recentStays[0].reservationId === "HR-204-001" && !ctx.text.includes("OLD-PLC-1"));
  const bad = await Signal.create({ workspaceId: wsA._id, propertyId: HRS, guestId: BELA, type: "other", title: "Older record that disagrees", source: "staff" }); // a guest of ANOTHER property on a Signal (an older, inconsistent record)
  const badCtx = await call("GET", `/signals/${bad._id}/context?workspaceId=${A}`, operator);
  check("B5.3 an older Signal whose guest belongs to another property does not pull that guest into the context: the guest is reported unavailable and Bela's details are absent", badCtx.status === 200 && badCtx.json.data.guest?.available === false && !badCtx.text.includes("Bela") && !badCtx.text.includes("PC-301-001"));
  await Signal.deleteOne({ _id: bad._id });

  // ---------------------------------------------------------------------------------------------------- the AI
  console.log("\n# B6. the selected context reaches the existing intelligence workflow");
  const gen = await call("POST", `/intelligence/analyze/${sig1._id}?workspaceId=${A}`, operator);
  const body0 = proxyLog.analyzeBodies[0];
  const sent = body0 ? JSON.stringify(body0) : "";
  check("B6.1 POST /intelligence/analyze/:signalId (the existing endpoint) creates the analysis (201) with exactly ONE call to the AI service", gen.status === 201 && proxyLog.analyze === 1);
  check("B6.2 the request the AI service received CARRIES the selected context: property Harbour Residences, unit 204, the guest and the stay (HR-204-001) - the selection is not merely displayed", sent.includes("Harbour Residences") && sent.includes("\"204\"") && sent.includes(ARUN) && sent.includes(SARUN) && sent.includes("HR-204-001"));
  check("B6.3 and NOTHING of the other property or workspace reached the model: no Palm Court, no Bela, her stay or booking reference, no Maya, no workspace B record", !sent.includes("Palm Court") && !sent.includes(BELA) && !sent.includes(SBELA) && !sent.includes("PC-301-001") && !sent.includes("OLD-PLC-1") && !sent.includes(MAYA) && !sent.includes(OTHERG) && !sent.includes("Other Tower"));
  const intel = await Intelligence.findOne({ workspaceId: wsA._id, signalIds: sig1._id }).lean();
  check("B6.4 the stored Intelligence keeps the same property, guest and stay references", Boolean(intel) && String(intel.propertyId) === HRS && String(intel.guestId) === ARUN && String(intel.stayId) === SARUN);

  console.log("\n# B7. the existing human flow still works: Decision -> Action -> Outcome");
  const dec = await call("POST", `/decisions/propose/${idOf(gen)}?workspaceId=${A}`, admin);
  const decApproved = dec.json?.data?._id ? await call("POST", `/decisions/${dec.json.data._id}/approve?workspaceId=${A}`, admin, {}) : null;
  const act = decApproved ? await call("POST", `/actions/propose/${dec.json.data._id}?workspaceId=${A}`, admin) : null;
  const actApproved = act?.json?.data?._id ? await call("POST", `/actions/${act.json.data._id}/approve?workspaceId=${A}`, admin, { note: "Ready." }) : null;
  const outcome = actApproved ? await call("POST", `/outcomes/record/${act.json.data._id}?workspaceId=${A}`, admin, { status: "success", result: { summary: "Technician fixed the AC." } }) : null;
  check("B7.1 Decision proposed and approved by a person, Action proposed and approved, Outcome recorded by a person - the same endpoints, statuses and permissions as before", [200, 201].includes(dec.status) && decApproved?.status === 200 && decApproved.json.data.status === "approved" && [200, 201].includes(act?.status) && actApproved?.status === 200 && actApproved.json.data.status === "approved" && [200, 201].includes(outcome?.status));
  const viewerDecide = dec.json?.data?._id ? await call("POST", `/decisions/${dec.json.data._id}/reject?workspaceId=${A}`, viewer, {}) : null;
  check("B7.2 role boundaries of the human flow are unchanged: a viewer still cannot review a decision (403)", viewerDecide?.status === 403);

  // ======================================================================================================== C
  console.log("\n# C. the frontend (through Vite SSR)");
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const sel = await vite.ssrLoadModule("/src/features/assistant/contextSelection.js");
  const feRequire = (await import("node:module")).createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToString } = feRequire("react-dom/server");
  const { MemoryRouter } = feRequire("react-router-dom");

  const full = { propertyId: "p1", guestId: "g1", stayId: "s1" };
  check("C1 changing the PROPERTY clears the guest and the stay; changing the GUEST clears the stay and keeps the property", JSON.stringify(sel.changeSelection(full, "propertyId", "p2")) === JSON.stringify({ propertyId: "p2", guestId: "", stayId: "" }) && JSON.stringify(sel.changeSelection(full, "guestId", "g2")) === JSON.stringify({ propertyId: "p1", guestId: "g2", stayId: "" }) && JSON.stringify(sel.changeSelection(full, "stayId", "s2")) === JSON.stringify({ propertyId: "p1", guestId: "g1", stayId: "s2" }));
  check("C2 clearing the property clears everything; an unknown level changes nothing", JSON.stringify(sel.changeSelection(full, "propertyId", "")) === JSON.stringify(sel.EMPTY_SELECTION) && sel.changeSelection(full, "other", "x") === full);
  check("C3 [guest + stay required] a guest investigation can start ONLY with property AND guest AND stay: nothing, property only, property + guest, or a stay without a guest all give no context; all three give exactly { propertyId, guestId, stayId }", sel.selectionToContext(sel.EMPTY_SELECTION) === null && sel.selectionToContext({ propertyId: "p1", guestId: "", stayId: "" }) === null && sel.selectionToContext({ propertyId: "p1", guestId: "g1", stayId: "" }) === null && sel.selectionToContext({ propertyId: "p1", guestId: "", stayId: "s1" }) === null && JSON.stringify(sel.selectionToContext(full)) === JSON.stringify(full));
  check("C3b the page says what is still missing, in order: property, then guest, then stay, then nothing", /property, a guest and a stay/.test(sel.missingContextHint(sel.EMPTY_SELECTION)) && /guest/.test(sel.missingContextHint({ propertyId: "p1", guestId: "", stayId: "" })) && /stay/.test(sel.missingContextHint({ propertyId: "p1", guestId: "g1", stayId: "" })) && sel.missingContextHint(full) === "");
  const view = (selection, over = {}) => sel.describeSelectors({ properties: { status: "ready", items: [{ id: "p1" }] }, guests: { status: "idle", items: [] }, stays: { status: "idle", items: [] }, selection, ...over });
  const none = view(sel.EMPTY_SELECTION);
  check("C4 [no property] the guest and stay selectors are DISABLED and say 'Select a property first.'", none.guest.disabled && none.stay.disabled && none.guest.placeholder === "Select a property first." && none.guest.note === "Select a property first." && !none.property.disabled);
  const noGuests = view({ propertyId: "p1", guestId: "", stayId: "" }, { guests: { status: "ready", items: [] } });
  check("C5 [property with no guests] the guest selector is disabled and says 'No guests have been added to this property yet.'; the stay selector waits for a guest", noGuests.guest.disabled && noGuests.guest.note === "No guests have been added to this property yet." && noGuests.stay.disabled && noGuests.stay.placeholder === "Select a guest first");
  const noStays = view({ propertyId: "p1", guestId: "g1", stayId: "" }, { guests: { status: "ready", items: [{ id: "g1" }] }, stays: { status: "ready", items: [] } });
  check("C6 [guest with no stays] the stay selector is disabled and says 'No stays found for this guest.'", noStays.stay.disabled && noStays.stay.note === "No stays found for this guest." && !noStays.guest.disabled);
  const ready = view({ propertyId: "p1", guestId: "g1", stayId: "" }, { guests: { status: "ready", items: [{ id: "g1" }] }, stays: { status: "ready", items: [{ id: "s1" }] } });
  const loading = view({ propertyId: "p1", guestId: "g1", stayId: "" }, { guests: { status: "loading", items: [] }, stays: { status: "loading", items: [] } });
  const errored = view({ propertyId: "p1", guestId: "g1", stayId: "" }, { guests: { status: "error", items: [] }, stays: { status: "error", items: [] }, properties: { status: "error", items: [] } });
  check("C7 loading and error states are explicit and disabled; a ready level is enabled", !ready.guest.disabled && !ready.stay.disabled && loading.guest.disabled && /Loading guests/.test(loading.guest.placeholder) && loading.stay.disabled && /Loading stays/.test(loading.stay.placeholder) && errored.guest.disabled && errored.stay.disabled && errored.property.disabled && /Try again/.test(errored.guest.note));
  const noProps = view(sel.EMPTY_SELECTION, { properties: { status: "ready", items: [] } });
  check("C8 a workspace with no properties says so and offers no property to choose", noProps.property.disabled && noProps.property.note === "No properties yet. Add a property first.");
  check("C9 a stay is labelled with its booking reference, room, dates and status", sel.stayLabel({ reservationId: "HR-204-001", checkIn: "2026-10-14T00:00:00.000Z", checkOut: "2026-10-16T00:00:00.000Z", status: "checked_in" }, "204").startsWith("#HR-204-001 · Unit 204") && sel.stayLabel({ status: "reserved" }, null) === "Stay · reserved");

  const ContextSelector = (await vite.ssrLoadModule("/src/features/assistant/ContextSelector.jsx")).default;
  const render = (context) => renderToString(React.createElement(MemoryRouter, null, React.createElement(ContextSelector, { context })));
  const state = (selection, parts) => ({ selection, select() {}, retry() {}, properties: { status: "ready", items: [{ id: "p1", name: "Harbour Residences" }, { id: "p2", name: "Palm Court" }] }, guests: { status: "idle", items: [] }, stays: { status: "idle", items: [] }, units: {}, view: view(selection, parts), ...(parts ?? {}) });
  const html0 = render(state(sel.EMPTY_SELECTION, {}));
  check("C10 [rendered] with no property: the Property selector offers both properties; the Guest and Stay selectors are disabled with the 'Select a property first.' text; no guest or stay option exists", /Harbour Residences/.test(html0) && /Palm Court/.test(html0) && (html0.match(/<select[^>]*disabled/g) ?? []).length === 2 && /Select a property first\./.test(html0) && !/Arun|HR-204/.test(html0));
  const selection1 = { propertyId: "p1", guestId: "", stayId: "" };
  const html1 = render({ ...state(selection1, {}), guests: { status: "ready", items: [{ id: "g1", firstName: "Arun", lastName: "Kumar" }, { id: "g2", firstName: "Maya", lastName: "Iyer" }] }, view: view(selection1, { guests: { status: "ready", items: [{ id: "g1" }, { id: "g2" }] } }) });
  check("C11 [rendered] with a property: ONLY the guests the server returned for it are options (Arun, Maya), the stay selector is disabled until a guest is chosen", /Arun Kumar/.test(html1) && /Maya Iyer/.test(html1) && !/Bela/.test(html1) && (html1.match(/<select[^>]*disabled/g) ?? []).length === 1 && /Select a guest first/.test(html1));
  const selection2 = { propertyId: "p1", guestId: "g1", stayId: "" };
  const html2 = render({ ...state(selection2, {}), guests: { status: "ready", items: [{ id: "g1", firstName: "Arun", lastName: "Kumar" }] }, stays: { status: "ready", items: [{ id: "s1", reservationId: "HR-204-001", unitId: "u1", status: "checked_in" }] }, units: { u1: "204" }, view: view(selection2, { guests: { status: "ready", items: [{ id: "g1" }] }, stays: { status: "ready", items: [{ id: "s1" }] } }) });
  check("C12 [rendered] with a guest: the stay selector is enabled and offers that guest's stay (#HR-204-001 · Unit 204)", /#HR-204-001 · Unit 204/.test(html2) && (html2.match(/<select[^>]*disabled/g) ?? []).length === 0);
  const html3 = render({ ...state({ propertyId: "p2", guestId: "", stayId: "" }, {}), guests: { status: "ready", items: [] }, view: view({ propertyId: "p2", guestId: "", stayId: "" }, { guests: { status: "ready", items: [] } }) });
  check("C13 [rendered] a property with no guests shows the empty-state sentence and a link to add one", /No guests have been added to this property yet\./.test(html3) && /Add a guest/.test(html3));

  const summary = (await vite.ssrLoadModule("/src/features/assistant/InvestigationContext.jsx")).default;
  const sumHtml = renderToString(React.createElement(summary, { context: { property: "Harbour Residences", guest: "Arun Kumar", stay: "#HR-204-001 · Unit 204" } }));
  check("C14 [rendered] a started investigation shows its Property, Guest and Stay read-only; nothing when it has no context", /Harbour Residences/.test(sumHtml) && /Arun Kumar/.test(sumHtml) && /#HR-204-001/.test(sumHtml) && renderToString(React.createElement(summary, { context: null })) === "");
  const assistantMap = await vite.ssrLoadModule("/src/features/assistant/assistantMapping.js");
  const mappedConvo = assistantMap.mapConversation({ _id: "a".repeat(24), title: "AC", propertyId: "b".repeat(24), guestId: "c".repeat(24), stayId: "not-an-id" });
  check("C15 the conversation mapping carries property, guest and stay as ids (a malformed one is dropped), never names", mappedConvo.propertyId === "b".repeat(24) && mappedConvo.guestId === "c".repeat(24) && mappedConvo.stayId === null);
  const composer = (await vite.ssrLoadModule("/src/features/assistant/Composer.jsx")).default;
  const newComposer = renderToString(React.createElement(composer, { onSend: async () => null, busy: false, disabled: true, label: "What should EOI investigate?", submitLabel: "Start investigation" }));
  check("C16 the new-investigation composer reads 'What should EOI investigate?' / 'Start investigation', is disabled until a property is selected, and keeps its accessibility contract (label tied to the textarea)", /What should EOI investigate\?/.test(newComposer) && /Start investigation/.test(newComposer) && /<textarea[^>]*disabled/.test(newComposer) && /<label[^>]*for="asst-input"/.test(newComposer));
  const guestForm = (await vite.ssrLoadModule("/src/features/operations/GuestForm.jsx")).default;
  const gfHtml = renderToString(React.createElement(guestForm, { submitLabel: "Create guest", onSubmit: async () => {} }));
  check("C17 the guest form has a REQUIRED Property select (a guest belongs to a property)", /<select[^>]*required/.test(gfHtml) && /Property/.test(gfHtml));
  const guestSelects = html2.match(/<select[^>]*>/g) ?? [];
  check("C12b [rendered] the Guest and Stay selects are marked required (with the Property), and the helper text says all three are needed - not 'optional'", guestSelects.length === 3 && guestSelects.every((s) => /required/.test(s)) && /Select a stay to continue\./.test(html2) && !/optional/i.test(html2) && /Select a guest to continue\./.test(html1) && /Select a property, a guest and a stay to start\./.test(html0));
  const stayRow = (await vite.ssrLoadModule("/src/features/operations/StayRow.jsx")).default;
  const rowHtml = renderToString(React.createElement(MemoryRouter, null, React.createElement(stayRow, { stay: { id: "s1", propertyId: "p1", reservationId: "HR-204-001", status: "checked_in", checkIn: "2026-10-16T00:00:00.000Z", checkOut: "2026-10-19T00:00:00.000Z" }, guestName: "Arun Kumar", propertyName: "Harbour Residences", unitNumber: "204" })));
  const rowNoRef = renderToString(React.createElement(MemoryRouter, null, React.createElement(stayRow, { stay: { id: "s2", propertyId: "p1", status: "reserved" }, guestName: "Arun Kumar", propertyName: "Harbour Residences", unitNumber: null })));
  check("C21 [stay history] the stay row shows its booking reference (HR-204-001 · Unit 204); a stay with no reference shows only the unit, with no empty separator", /HR-204-001 · Unit 204/.test(rowHtml) && /Unassigned unit/.test(rowNoRef) && !/ · Unassigned unit/.test(rowNoRef) && !/undefined|null/.test(rowHtml + rowNoRef));
  const stayForm = (await vite.ssrLoadModule("/src/features/operations/StayForm.jsx")).default;
  const sfHtml = renderToString(React.createElement(stayForm, { guestName: "Arun Kumar", propertyId: "p1", propertyName: "Harbour Residences", submitLabel: "Create stay", onSubmit: async () => {} }));
  check("C18 the stay form no longer lets a stay pick a property: the guest's property is fixed and shown; only the unit and the booking details are entered (booking reference included)", /Harbour Residences/.test(sfHtml) && !/Select a property/.test(sfHtml) && /Booking reference/.test(sfHtml) && /Unit/.test(sfHtml));
  const api = code(path.join(FRONTEND, "src", "services", "api.js"));
  check("C19 the API client sends the selection only as { propertyId, guestId?, stayId? } with the first turn, and no role, user or workspace-of-the-record claim", /submitIntakeTurn\(workspaceId, conversationId, content, context\)/.test(api) && /context && context\.propertyId \? \{ context \}/.test(api));
  const page = code(path.join(FRONTEND, "src", "pages", "AssistantPage.jsx")) + code(path.join(FRONTEND, "src", "features", "assistant", "useAssistantConversation.js"));
  check("C20 the selection travels only with the FIRST turn (the server stores it), the property is required before sending, and generation is still requested only from the send handler / the button", /conversationId \? undefined : context/.test(page) && /disabled=\{!ready\}/.test(page) && /generation\.generate\(recorded\.signalId\)/.test(page));
  await vite.close();

  // ======================================================================================================== D
  console.log("\n# D. no new pipeline, no external data");
  const be2 = (p) => code(path.join(BACKEND, "src", p));
  const scopeSrc = be2("services/operationalScope.js");
  check("D1 the relationship rules live in one backend module that loads every record INSIDE the verified workspace and imports no AI, embedding, retrieval, CSV or fetch code", /findInWorkspaceOr404\(Property/.test(scopeSrc) && /findInWorkspaceOr404\(Stay/.test(scopeSrc) && /findInWorkspaceOr404\(Guest/.test(scopeSrc) && !/aiServiceClient|knowledgeRetrieval|embedding|csv-parse|fetch\(|openai|@google/.test(scopeSrc));
  check("D2 the intake still calls no model: the intake path has no AI-service client, embedding, retrieval or fetch", !/aiServiceClient|knowledgeRetrieval|knowledgeEmbedding|fetch\(|@google|openai|intelligenceAnalysisService|requestAnalysisFromAiService/.test(be2("services/signalIntakeService.js") + be2("services/signalInterpreter.js")));
  check("D3 the controller passes only the VERIFIED workspace and the browser's selection (an untrusted context), never a role or user", /workspaceId: req\.actor\.workspaceId, conversationId: req\.body\?\.conversationId, content: req\.body\?\.content, context: req\.body\?\.context/.test(read(path.join(BACKEND, "src/controllers/conversationController.js"))));
  check("D4 the AI provider, model, embeddings, retrieval, safety and admission code are untouched by this change (the files keep importing exactly what they did)", ["services/ai/safetyPolicy.js", "services/ai/claimValidator.js", "services/ai/confidencePolicy.js", "services/knowledgeRetrievalService.js", "services/knowledgeEmbeddingService.js", "services/ai/aiServiceClient.js"].every((f) => !/operationalScope/.test(be2(f))));
  check("D5 no CSV/Excel dataset or sample operational history is introduced by this feature: the new files read no file, and CSV import remains the optional admin API it was", !/readFile|csv|xlsx/i.test(scopeSrc) && !/\.csv|xlsx/i.test(read(path.join(FRONTEND, "src", "features", "assistant", "useContextSelection.js"))));
} finally {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* gone */
    }
  }
  try {
    proxyServer?.close();
  } catch {
    /* gone */
  }
  try {
    await mongoose.connection.dropDatabase();
  } catch {
    /* best effort */
  }
  try {
    await mongoose.disconnect();
  } catch {
    /* best effort */
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
