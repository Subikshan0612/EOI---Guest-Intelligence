/**
 * ADD GUEST + STAY + UNIT IN ONE WORKFLOW  -  POST /guests with a `stay`.
 *
 *   node backend/scripts/validate-guest-stay-create.mjs     (needs a loopback MongoDB: MONGODB_URI=mongodb://127.0.0.1:27017/<any>; a throwaway database is derived and dropped)
 *
 *   1  the combined create: guest + stay + unit are saved together, under one workspace + property, the unit shown as its room number
 *   2  the SERVER validates the combination: another property's unit, another workspace's unit / property, forged ids inside `stay` - nothing is created
 *   3  no duplicates, no half-saved state (an invalid stay leaves no guest behind; a duplicate booking reference removes the guest this call created)
 *   4  the existing Guest -> Stay functionality, role boundaries and the Assistant Property -> Guest -> Stay workflow still work on a combined record
 *   5  the form (through Vite SSR): the guest fields and the Stay Details appear once a property is chosen; the stay's fields are the requested ones
 *   No Gemini, no ai-service, no key, no Atlas, no CSV.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const FRONTEND = path.join(BACKEND, "..", "frontend");
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

// ---- isolated database, derived from an explicit loopback URI (never printed)
const baseUri = process.env.MONGODB_URI;
const DB_NAME = `koi_gs_${Date.now()}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) {
  console.error("refusing: set MONGODB_URI to a plain loopback MongoDB (no credentials)");
  process.exit(2);
}
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);

const { createActor } = await import("./lib/authFixtures.mjs");
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { Workspace, Guest, Stay, Signal, Conversation, Unit } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) {
  console.error("refusing: not connected to the isolated database");
  process.exit(2);
}

const children = [];
try {
  const API_PORT = 5098;
  const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(API_PORT), LLM_PROVIDER: "test" }, stdio: "ignore" });
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

  const stamp = Date.now();
  const wsA = await Workspace.create({ name: `GS a ${stamp}`, slug: `gs-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `GS b ${stamp}`, slug: `gs-b-${stamp}`, status: "active" });
  const A = String(wsA._id);
  const B = String(wsB._id);
  const admin = await createActor({ role: "admin", workspaceId: wsA._id, label: "gs-admin" });
  const operator = await createActor({ role: "operator", workspaceId: wsA._id, label: "gs-op" });
  const viewer = await createActor({ role: "viewer", workspaceId: wsA._id, label: "gs-viewer" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "gs-adminb" });
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
  const idOf = (r) => r.json?.data?._id;
  const day = 86400000;
  const iso = (offset) => new Date(Date.UTC(2026, 9, 16) + offset * day).toISOString();

  const HRS = idOf(await call("POST", "/properties", admin, { workspaceId: A, name: "Harbour Residences", code: "HRS" }));
  const PLC = idOf(await call("POST", "/properties", admin, { workspaceId: A, name: "Palm Court", code: "PLC" }));
  const OTW = idOf(await call("POST", "/properties", adminB, { workspaceId: B, name: "Other Tower", code: "OTW" }));
  const mkUnit = (ws, who, propertyId, unitNumber) => call("POST", "/units", who, { workspaceId: ws, propertyId, unitNumber });
  const u204 = idOf(await mkUnit(A, admin, HRS, "204"));
  const u205 = idOf(await mkUnit(A, admin, HRS, "205"));
  const u301 = idOf(await mkUnit(A, admin, PLC, "301"));
  const uOtw = idOf(await mkUnit(B, adminB, OTW, "204"));
  check("S0 the dataset exists (2 properties + 3 units in workspace A, 1 + 1 in workspace B), built through the application's own APIs", [HRS, PLC, OTW, u204, u205, u301, uOtw].every(Boolean));

  const counts = async () => ({ guests: await Guest.countDocuments({}), stays: await Stay.countDocuments({}) });
  const combined = (over = {}, stayOver = {}, who = operator, ws = A) =>
    call("POST", "/guests", who, {
      workspaceId: ws,
      propertyId: HRS,
      firstName: "Arun",
      lastName: "Kumar",
      email: "arun.kumar@example.com",
      phone: "+91 98765 43210",
      stay: { reservationId: "HR-204-001", unitId: u204, checkIn: iso(0), checkOut: iso(3), status: "checked_in", ...stayOver },
      ...over,
    });

  // ---------------------------------------------------------------------------------------------------- 1
  console.log("\n# 1. the combined create");
  const before1 = await counts();
  const ok = await combined();
  const guestDoc = ok.json?.data?._id ? await Guest.findById(ok.json.data._id).lean() : null;
  const stayDoc = ok.json?.data?.stay?._id ? await Stay.findById(ok.json.data.stay._id).lean() : null;
  const after1 = await counts();
  check("T1 [create guest + stay + unit together] Arun Kumar at Harbour Residences with stay HR-204-001, unit 204, 16-19 Oct, Checked In is saved in ONE request (201), the guest with its stay in the answer", ok.status === 201 && ok.json?.success === true && ok.json.data.firstName === "Arun" && ok.json.data.email === "arun.kumar@example.com" && ok.json.data.phone === "+91 98765 43210" && ok.json.data.stay?.reservationId === "HR-204-001" && ok.json.data.stay.status === "checked_in", `status ${ok.status}`);
  check("T2 [guest belongs to the selected property] the stored guest has the workspace and Harbour Residences", String(guestDoc?.workspaceId) === A && String(guestDoc?.propertyId) === HRS);
  check("T3 [stay belongs to the same property and guest] the stored stay has the SAME workspace, property and the new guest's id", String(stayDoc?.workspaceId) === A && String(stayDoc?.propertyId) === HRS && String(stayDoc?.guestId) === String(guestDoc?._id) && ok.json?.data?.stay?.guestId === ok.json?.data?._id);
  const unitRead = stayDoc?.unitId ? await call("GET", `/units/${stayDoc.unitId}?workspaceId=${A}`, operator) : null;
  check("T4 [the stay contains the selected unit] the stored stay's unit is unit 204 of Harbour Residences - shown as '204', not 'Unassigned'", String(stayDoc?.unitId) === u204 && unitRead?.json?.data?.unitNumber === "204" && String(unitRead?.json?.data?.propertyId) === HRS);
  check("T4b the dates and status are stored as entered (16 Oct to 19 Oct, checked_in)", stayDoc?.checkIn?.toISOString() === iso(0) && stayDoc?.checkOut?.toISOString() === iso(3) && stayDoc?.status === "checked_in");
  check("T5 [no duplicates] exactly ONE guest and ONE stay were created by the save", after1.guests - before1.guests === 1 && after1.stays - before1.stays === 1);
  const ARUN = String(guestDoc?._id);
  const SARUN = String(stayDoc?._id);

  // ---------------------------------------------------------------------------------------------------- 2
  console.log("\n# 2. the server validates the combination");
  const b2 = await counts();
  const otherPropertyUnit = await combined({ firstName: "Wrong", lastName: "Unit" }, { reservationId: "X-1", unitId: u301 });
  check("T6 [a unit from another property is rejected] Palm Court's unit 301 with a Harbour Residences guest: 400, nothing created", otherPropertyUnit.status === 400 && /Unit does not belong/.test(otherPropertyUnit.text), `status ${otherPropertyUnit.status}`);
  const foreignUnit = await combined({ firstName: "Wrong", lastName: "Workspace" }, { reservationId: "X-2", unitId: uOtw });
  check("T7a [cross-workspace unit] another workspace's unit is the same 404 as a missing one", foreignUnit.status === 404);
  const foreignProperty = await combined({ propertyId: OTW, firstName: "Wrong", lastName: "Property" }, { reservationId: "X-3", unitId: uOtw });
  check("T7b [cross-workspace property] another workspace's property (with its own unit) is a 404 for this workspace's operator", foreignProperty.status === 404);
  const foreignActor = await combined({ firstName: "Wrong", lastName: "Actor" }, { reservationId: "X-4", unitId: u204 }, adminB, B);
  check("T7c [cross-workspace combination] workspace B's admin naming workspace A's property and unit gets a 404 - A's records are never reachable", foreignActor.status === 404);
  const spoofedWs = await call("POST", "/guests", operator, { workspaceId: B, propertyId: OTW, firstName: "Spoof", lastName: "Body", stay: { unitId: uOtw, reservationId: "X-5" } });
  check("T7d [workspace taken from the credential] a body that claims workspace B is refused for workspace A's operator (nothing is created in B)", [403, 404].includes(spoofedWs.status) && (await Guest.countDocuments({ workspaceId: wsB._id, firstName: "Spoof" })) === 0, `status ${spoofedWs.status}`);
  const forged = await combined({ firstName: "Forged", lastName: "Ids" }, { reservationId: "HR-205-001", unitId: u205, propertyId: PLC, guestId: ARUN, workspaceId: B });
  const forgedStay = forged.json?.data?.stay ? await Stay.findById(forged.json.data.stay._id).lean() : null;
  check("T8 [forged ids are ignored] a `stay` that names another property, another guest and another workspace is created at the guest's OWN workspace, property and guest", forged.status === 201 && String(forgedStay?.propertyId) === HRS && String(forgedStay?.workspaceId) === A && String(forgedStay?.guestId) === forged.json.data._id && String(forgedStay?.guestId) !== ARUN);
  const badDates = await combined({ firstName: "Bad", lastName: "Dates" }, { reservationId: "X-6", checkIn: iso(5), checkOut: iso(2) });
  const badStatus = await combined({ firstName: "Bad", lastName: "Status" }, { reservationId: "X-7", status: "teleported" });
  const badUnit = await combined({ firstName: "Bad", lastName: "Unit Id" }, { reservationId: "X-8", unitId: "not-an-id" });
  const notObject = await call("POST", "/guests", operator, { workspaceId: A, propertyId: HRS, firstName: "Not", lastName: "Object", stay: "HR-204-001" });
  check("T9 invalid stay input is refused with a clean 400 and nothing is created: check-out before check-in, an unknown status, a malformed unit id, a `stay` that is not an object", badDates.status === 400 && badStatus.status === 400 && badUnit.status === 400 && notObject.status === 400, `${badDates.status}/${badStatus.status}/${badUnit.status}/${notObject.status}`);
  const noProperty = await call("POST", "/guests", operator, { workspaceId: A, firstName: "No", lastName: "Property", stay: { reservationId: "X-9" } });
  check("T9b a combined create still needs the property (400)", noProperty.status === 400);
  const a2 = await counts();
  check("T10 every refused request left NOTHING behind (only the one accepted forged-ids request added a guest and a stay)", a2.guests - b2.guests === 1 && a2.stays - b2.stays === 1, JSON.stringify({ b2, a2 }));

  // ---------------------------------------------------------------------------------------------------- 3
  console.log("\n# 3. no duplicates, no half-saved state");
  const b3 = await counts();
  const overlap = await combined({ firstName: "Over", lastName: "Lap" }, { reservationId: "HR-204-002", unitId: u204, checkIn: iso(1), checkOut: iso(2) });
  check("T11 a unit that is already booked for those dates is a 409 and NO guest is left behind (the stay is checked before the guest is written)", overlap.status === 409 && (await Guest.countDocuments({ lastName: "Lap" })) === 0);
  const dupRef = await combined({ firstName: "Dup", lastName: "Reference" }, { reservationId: "HR-204-001", unitId: u205, checkIn: iso(10), checkOut: iso(12) });
  check("T12 a booking reference that already exists is a 409 and the guest this request created is REMOVED again - no guest without the stay the operator asked for", dupRef.status === 409 && (await Guest.countDocuments({ lastName: "Reference" })) === 0, `status ${dupRef.status}`);
  const a3 = await counts();
  check("T13 after both failures the counts are exactly what they were", a3.guests === b3.guests && a3.stays === b3.stays);
  const noStay = await call("POST", "/guests", operator, { workspaceId: A, propertyId: HRS, firstName: "Solo", lastName: "Guest" });
  check("T14 [existing behaviour] POST /guests without a stay is unchanged: 201, a guest with no stay key and no stay record", noStay.status === 201 && noStay.json.data.stay === undefined && (await Stay.countDocuments({ guestId: noStay.json.data._id })) === 0);
  const unassigned = await combined({ firstName: "Una", lastName: "Ssigned" }, { reservationId: "HR-TBD-001", unitId: null, status: "reserved" });
  const unassignedDoc = unassigned.json?.data?.stay?._id ? await Stay.findById(unassigned.json.data.stay._id).lean() : null;
  check("T15 an unassigned stay stays legitimate: no unit chosen saves the stay with no unit (the form shows 'Unassigned unit' for it)", unassigned.status === 201 && !unassignedDoc?.unitId && String(unassignedDoc?.propertyId) === HRS);

  // ---------------------------------------------------------------------------------------------------- 4
  console.log("\n# 4. the existing functionality is unchanged");
  const viewerTry = await combined({ firstName: "View", lastName: "Er" }, { reservationId: "X-10" }, viewer);
  check("T16 role boundaries are unchanged: a viewer cannot create a guest + stay (403), an operator can", viewerTry.status === 403 && ok.status === 201);
  const separateStay = await call("POST", "/stays", operator, { workspaceId: A, guestId: noStay.json.data._id, propertyId: HRS, unitId: u205, reservationId: "HR-205-002", status: "reserved", checkIn: iso(20), checkOut: iso(22) });
  check("T17 [Guest -> Stay still works] a stay can still be added to an existing guest through POST /stays, with a unit of the guest's property", separateStay.status === 201 && separateStay.json.data.unitId === u205);
  const wrongSeparate = await call("POST", "/stays", operator, { workspaceId: A, guestId: noStay.json.data._id, propertyId: HRS, unitId: u301, reservationId: "HR-X-3" });
  check("T18 POST /stays still refuses another property's unit (400)", wrongSeparate.status === 400);
  const editGuest = await call("PATCH", `/guests/${ARUN}?workspaceId=${A}`, operator, { phone: "+91 90000 00000" });
  const editStay = await call("PATCH", `/stays/${SARUN}?workspaceId=${A}`, operator, { status: "checked_out" });
  const editStayUnit = await call("PATCH", `/stays/${SARUN}?workspaceId=${A}`, operator, { unitId: u301 });
  check("T19 editing a combined guest and its stay works (200), and the stay still refuses another property's unit when edited (400)", editGuest.status === 200 && editStay.status === 200 && editStayUnit.status === 400);
  const listGuests = await call("GET", `/guests?workspaceId=${A}&propertyId=${HRS}&limit=100`, operator);
  const listStays = await call("GET", `/stays?workspaceId=${A}&guestId=${ARUN}&propertyId=${HRS}`, operator);
  check("T20 [Assistant selectors] Property -> Guest -> Stay lists return the new records: the property's guests include Arun, and Arun's stays at that property are exactly HR-204-001", listGuests.json.data.some((g) => g._id === ARUN) && listStays.json.data.length === 1 && listStays.json.data[0].reservationId === "HR-204-001" && listStays.json.data[0].unitId === u204);
  const otherList = await call("GET", `/guests?workspaceId=${A}&propertyId=${PLC}&limit=100`, operator);
  check("T21 the other property does not offer the new guest", otherList.status === 200 && !otherList.json.data.some((g) => g._id === ARUN));
  const turn = await call("POST", "/conversations/intake", operator, { workspaceId: A, content: "AC is not cooling.", context: { propertyId: HRS, guestId: ARUN, stayId: SARUN } });
  const sig = turn.json?.data?.signal ? await Signal.findById(turn.json.data.signal._id).lean() : null;
  const convo = turn.json?.data?.conversation ? await Conversation.findById(turn.json.data.conversation._id).lean() : null;
  check("T22 [Assistant workflow] an investigation started on the combined record verifies and stores Property + Guest + Stay + the stay's unit 204 on its Signal and Conversation", turn.status === 201 && String(sig?.propertyId) === HRS && String(sig?.guestId) === ARUN && String(sig?.stayId) === SARUN && String(sig?.unitId) === u204 && String(convo?.stayId) === SARUN, `status ${turn.status}`);
  const turnWrongProperty = await call("POST", "/conversations/intake", operator, { workspaceId: A, content: "AC is not cooling.", context: { propertyId: PLC, guestId: ARUN, stayId: SARUN } });
  check("T23 the Assistant still refuses the guest/stay of another property (400/404, no Signal created)", [400, 404].includes(turnWrongProperty.status));

  // ---------------------------------------------------------------------------------------------------- 5
  console.log("\n# 5. the form (through Vite SSR)");
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const feRequire = (await import("node:module")).createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToString } = feRequire("react-dom/server");
  const guestForm = (await vite.ssrLoadModule("/src/features/operations/GuestForm.jsx")).default;
  const noProperty$ = renderToString(React.createElement(guestForm, { withStay: true, submitLabel: "Create guest", onSubmit: async () => {} }));
  check("T24 [UI] with no property chosen the form shows the Property select only - no guest fields, no Stay Details", /Property/.test(noProperty$) && !/First name/.test(noProperty$) && !/Stay details/.test(noProperty$) && !/Booking reference/.test(noProperty$));
  const withProperty$ = renderToString(React.createElement(guestForm, { withStay: true, defaultPropertyId: "p1", submitLabel: "Create guest", onSubmit: async () => {} }));
  check("T25 [UI] once a property is chosen the Guest fields (name, email, phone) and the Stay Details appear: Booking reference, Unit / Room, Check-in, Check-out, Status", ["First name", "Last name", "Email", "Phone", "Stay details", "Booking reference", "Unit / Room", "Check-in", "Check-out", "Status"].every((label) => withProperty$.includes(label)));
  check("T26 [UI] the room is a TEXT input (placeholder with examples 204, B1, A-12), not a dropdown, with no 'Unassigned' option and no 'Loading units' state; the stay statuses are offered and the stay is optional ('Add a stay now')", /<input[^>]*placeholder="e\.g\. 204, B1, A-12/.test(withProperty$) && !/Unassigned/.test(withProperty$) && !/Loading units/.test(withProperty$) && (withProperty$.match(/<select/g) ?? []).length === 2 && /Checked in/i.test(withProperty$) && /Add a stay now/.test(withProperty$));
  const stayFields = (await vite.ssrLoadModule("/src/features/operations/StayFields.jsx")).default;
  const sfReady$ = renderToString(React.createElement(stayFields, { values: { unitId: "u204", reservationId: "HR-204-001", checkIn: "2026-10-16", checkOut: "2026-10-19", status: "checked_in" }, onChange() {}, units: [{ id: "u204", unitNumber: "204" }, { id: "u205", unitNumber: "205" }], unitsStatus: "ready", unitLabel: "Unit / Room" }));
  check("T26b [UI] with the property's units loaded the selector offers them by room number (204, 205) plus 'Unassigned', selects 204, and the booking reference and dates are filled", /<option value="u204" selected="">204<\/option>/.test(sfReady$) && />205</.test(sfReady$) && /Unassigned/.test(sfReady$) && /value="HR-204-001"/.test(sfReady$) && /value="2026-10-16"/.test(sfReady$) && /value="2026-10-19"/.test(sfReady$));
  const editForm$ = renderToString(React.createElement(guestForm, { initialValues: { propertyId: "p1", firstName: "A", lastName: "B", email: "", phone: "" }, submitLabel: "Save guest", onSubmit: async () => {} }));
  check("T27 [UI] the edit form (no withStay) is unchanged: the guest fields, no Stay Details", /First name/.test(editForm$) && !/Stay details/.test(editForm$));
  const stayForm = (await vite.ssrLoadModule("/src/features/operations/StayForm.jsx")).default;
  const sf$ = renderToString(React.createElement(stayForm, { guestName: "Arun Kumar", propertyId: "p1", propertyName: "Harbour Residences", submitLabel: "Create stay", onSubmit: async () => {} }));
  check("T28 [UI] the existing stay form still shows its fields after sharing them with the guest form (Unit, Booking reference, Check-in, Check-out, Status; the fixed property)", ["Unit", "Booking reference", "Check-in", "Check-out", "Status", "Harbour Residences"].every((label) => sf$.includes(label)));
  await vite.close();


  // ---------------------------------------------------------------------------------------------------- 6
  console.log("\n# 6. any room / unit identifier, typed: 101, 204, B1, A-12, 12A, G01, Villa 3, Penthouse");
  const typed = (n, over = {}, who = admin, extra = {}) =>
    call("POST", "/guests", who, { workspaceId: A, propertyId: extra.propertyId ?? HRS, firstName: `Guest${n}`, lastName: `Typed${String(over.unitNumber ?? n).replace(/\W/g, "")}`, stay: { reservationId: `TY-${n}`, checkIn: iso(30 + n * 4), checkOut: iso(32 + n * 4), status: "reserved", ...over } });
  const unitsOf = (propertyId) => Unit.find({ propertyId }).lean();
  const idents = ["101", "204", "B1", "A-12", "12A", "G01", "Villa 3", "Penthouse"];
  const results = {};
  for (const [i, ident] of idents.entries()) results[ident] = await typed(i + 1, { unitNumber: ident });
  const stays6 = {};
  for (const ident of idents) stays6[ident] = results[ident].json?.data?.stay?._id ? await Stay.findById(results[ident].json.data.stay._id).lean() : null;
  const hrsUnits = await unitsOf(HRS);
  const unitByNumber = (n) => hrsUnits.find((u) => u.unitNumber === n);
  check("T32 [identifiers] every one of 101, 204, B1, A-12, 12A, G01, Villa 3, Penthouse is accepted (201) - numeric and alphanumeric alike", idents.every((n) => results[n].status === 201), idents.map((n) => `${n}:${results[n].status}`).join(" "));
  check("T33 each typed identifier resolves to ONE unit of Harbour Residences whose human-facing unitNumber is exactly what was typed, and the stay holds that unit's internal id (never the number)", idents.every((n) => unitByNumber(n) && String(stays6[n]?.unitId) === String(unitByNumber(n)._id) && String(stays6[n]?.unitId) !== n && String(stays6[n]?.propertyId) === HRS));
  check("T34 '204' resolved the EXISTING unit (no second 204): its id is the one created before, created=false; the other seven were created under Harbour Residences (created=true)", String(stays6["204"]?.unitId) === u204 && results["204"].json.data.unit.created === false && idents.filter((n) => n !== "204").every((n) => results[n].json.data.unit.created === true) && hrsUnits.filter((u) => u.unitNumber === "204").length === 1);
  const lower = await typed(20, { unitNumber: "b1", checkIn: iso(400), checkOut: iso(402) });
  const spaced = await typed(21, { unitNumber: "villa  3", checkIn: iso(410), checkOut: iso(412) });
  const hrsUnits2 = await unitsOf(HRS);
  check("T35 [no duplicate identifiers in a property] 'b1' and 'villa  3' resolve the existing 'B1' and 'Villa 3' (created=false, same unit ids); the property still has exactly one of each", lower.status === 201 && spaced.status === 201 && lower.json.data.unit.created === false && lower.json.data.unit._id === String(unitByNumber("B1")._id) && spaced.json.data.unit._id === String(unitByNumber("Villa 3")._id) && hrsUnits2.length === hrsUnits.length);
  const plcB1 = await typed(22, { unitNumber: "B1" }, admin, { propertyId: PLC });
  const plcUnits = await unitsOf(PLC);
  const plcB1Unit = plcUnits.find((u) => u.unitNumber === "B1");
  check("T36 [property is the authority] 'B1' typed for Palm Court creates a SEPARATE B1 under Palm Court (created=true); Harbour Residences' B1 is untouched and never reused", plcB1.status === 201 && plcB1.json.data.unit.created === true && String(plcB1Unit?.propertyId) === PLC && String(plcB1Unit?._id) !== String(unitByNumber("B1")._id) && String((await Stay.findById(plcB1.json.data.stay._id).lean()).unitId) === String(plcB1Unit._id));
  const op301 = await typed(23, { unitNumber: "301" }, operator);
  const opKnown = await typed(24, { unitNumber: "205", checkIn: iso(500), checkOut: iso(502) }, operator);
  check("T37 [another property's room is never reused] '301' exists only at Palm Court: typed for Harbour Residences by an operator it is refused (403, no room, no guest); the Palm Court unit is unchanged", op301.status === 403 && /not set up/.test(op301.text) && (await Guest.countDocuments({ lastName: "Typed301" })) === 0 && (await unitsOf(HRS)).every((u) => u.unitNumber !== "301") && String((await unitsOf(PLC)).find((u) => u.unitNumber === "301")._id) === u301);
  check("T38 [who may add a room] an operator CAN use a room that already exists ('205' -> 201, created=false) but cannot make a new one (403) - adding a room needs the same permission as POST /units", opKnown.status === 201 && opKnown.json.data.unit.created === false && String(opKnown.json.data.unit._id) === u205);
  const admin301 = await typed(25, { unitNumber: "301" }, admin);
  check("T39 an administrator typing '301' for Harbour Residences gets a NEW 301 under Harbour Residences (created=true) - a different unit from Palm Court's 301", admin301.status === 201 && admin301.json.data.unit.created === true && admin301.json.data.unit._id !== u301 && String((await Unit.findById(admin301.json.data.unit._id).lean()).propertyId) === HRS);
  const both = await typed(26, { unitNumber: "B1", unitId: u204 });
  const blankNumber = await typed(27, { unitNumber: "   " });
  const badIdents = [];
  for (const bad of ["<script>", "-x", "a".repeat(41), "B1;DROP", "../204"]) badIdents.push((await typed(28, { unitNumber: bad })).status);
  const blankStay = blankNumber.json?.data?.stay ? await Stay.findById(blankNumber.json.data.stay._id).lean() : null;
  check("T40 unitId and unitNumber together are refused (400); a blank room saves an unassigned stay (201, no unit, no unit created); unsafe or over-long identifiers are 400 and create nothing", both.status === 400 && blankNumber.status === 201 && !blankStay?.unitId && blankNumber.json.data.unit === undefined && badIdents.every((st) => st === 400), badIdents.join("/"));
  const dupBefore = { guests: await Guest.countDocuments({}), units: await Unit.countDocuments({}) };
  const dupRef2 = await typed(29, { unitNumber: "Brand New 7", reservationId: "HR-204-001" });
  check("T41 [no half-saved state] a duplicate booking reference after a NEW room was typed: 409, and BOTH the guest and the room this call created are removed again", dupRef2.status === 409 && (await Guest.countDocuments({})) === dupBefore.guests && (await Unit.countDocuments({})) === dupBefore.units && !(await unitsOf(HRS)).some((u) => u.unitNumber === "Brand New 7"));
  const hrsUnitsBeforeForeign = (await unitsOf(HRS)).length;
  const foreignTyped = await typed(30, { unitNumber: "Z9" }, adminB, { propertyId: HRS });
  check("T42 [tenant isolation] workspace B's admin typing a room for workspace A's property: 404, nothing created in either workspace", foreignTyped.status === 404 && (await unitsOf(HRS)).length === hrsUnitsBeforeForeign && (await Unit.countDocuments({ propertyId: OTW })) === 1);

  // ---- the complete flow for numeric and alphanumeric identifiers: typed room -> stay -> Assistant -> room context
  for (const ident of ["101", "204", "B1", "A-12", "12A"]) {
    const g = results[ident].json.data;
    const turn6 = await call("POST", "/conversations/intake", operator, { workspaceId: A, content: "The air conditioning is not cooling.", context: { propertyId: HRS, guestId: g._id, stayId: g.stay._id } });
    const sig6 = turn6.json?.data?.signal ? await Signal.findById(turn6.json.data.signal._id).lean() : null;
    const ctx6 = sig6 ? await call("GET", `/signals/${sig6._id}/context?workspaceId=${A}`, operator) : null;
    const cd6 = ctx6?.json?.data;
    check(`T43[${ident}] [Assistant -> room context] an investigation on the stay of room ${ident} stores that unit on its Signal and the context endpoint returns the human-facing room '${ident}' (available)`, turn6.status === 201 && String(sig6?.unitId) === String(unitByNumber(ident)._id) && cd6?.unit?.available === true && cd6.unit.unitNumber === ident && cd6.stay?.reservationId === g.stay.reservationId, `status ${turn6.status}`);
  }

  // ---------------------------------------------------------------------------------------------------- source
  console.log("\n# architecture");
  const svc = code(path.join(BACKEND, "src", "services", "guestStayService.js"));
  const ctl = code(path.join(BACKEND, "src", "controllers", "guestController.js"));
  const unitsHook = code(path.join(FRONTEND, "src", "features", "operations", "useUnitsForProperty.js"));
  check("T29 the combined create reuses createGuest and createStay (no second implementation of the rules), reads no workspace, property or guest from `stay`, and the controller stays thin", /createGuest\(/.test(svc) && /createStay\(/.test(svc) && /STAY_FIELDS = \["unitId", "unitNumber", "reservationId", "checkIn", "checkOut", "status", "adults", "children", "source", "metadata"\]/.test(svc) && /workspaceId, guestId: guest\._id, propertyId \}/.test(svc) && /createGuestWithStay\(body, \{ canCreateUnit: actorHasPermission\(req\.actor, "workspace:admin"\) \}\)/.test(ctl) && !/Guest\.|Stay\./.test(ctl));
  check("T30 the unit options (existing guest's stay form) come from the chosen property only (GET /units?propertyId=) through the one API client", /propertyId, limit: 100/.test(unitsHook) && /koiApi/.test(unitsHook) && !/fetch\(|axios/.test(unitsHook));
  check("T31 no AI, embedding, retrieval, authentication, RBAC or tenancy code is touched by the combined create", !/ai\/|knowledge|embedding|retrieval|auth\//.test(svc));
} finally {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* gone */
    }
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
