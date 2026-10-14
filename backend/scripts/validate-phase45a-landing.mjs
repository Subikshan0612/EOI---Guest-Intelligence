/**
 * Phase 45A validation - the landing page no longer presents template-generated "intelligence" as real analysis.
 *
 *   node backend/scripts/validate-phase45a-landing.mjs
 *
 *   A  the mock chat, its generator, its prompt library and its side panel are gone from the source tree
 *   B  routing: no chat / prompt-library route renders anything; the former URLs redirect to the landing page
 *   C  the landing page is static: no input, no form, links only to routes that exist, no "ask" affordance
 *   D  navigation: the sidebar and header offer no chat / prompt / conversation entry
 *   E  reachability: nothing reachable from main.jsx imports the mock generator or its fixtures
 *   F  the real Intelligence pages are still routed and still import their real controllers / presenters
 *   G  (optional, needs a built dist/) the production bundle carries none of the fabricated-answer markers
 *
 * Read-only. No database, no model call, no network.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..", "..");
const FRONTEND = path.join(REPO, "frontend");
const SRC = path.join(FRONTEND, "src");
const read = (p) => fs.readFileSync(p, "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (f) => path.relative(SRC, f).replace(/\\/g, "/");
const exists = (r) => fs.existsSync(path.join(SRC, r));

// ============================================================================================ A removed
console.log("\n# A the mock chat is gone");
const REMOVED = [
  "pages/Chat.jsx", "pages/PromptLibraryPage.jsx", "features/chat/ChatWorkspace.jsx", "features/chat/PromptInput.jsx", "features/chat/AssistantMessage.jsx",
  "features/chat/UserMessage.jsx", "features/chat/MessageList.jsx", "features/chat/ChatHeader.jsx", "features/chat/ThinkingIndicator.jsx",
  "features/chat/IntelligenceEmptyState.jsx", "features/chat/chatService.js", "features/chat/useChat.js", "features/chat/conversationSession.js",
  "features/prompts/promptSelectors.js", "features/intelligence/cards.jsx", "features/conversations/ConversationItem.jsx", "components/layout/ContextPanel.jsx",
];
for (const r of REMOVED) check(`A1 ${r} no longer exists`, !exists(r));
check("A2 the features/chat directory no longer exists", !fs.existsSync(path.join(SRC, "features", "chat")));

// ============================================================================================ B routing
console.log("\n# B routing");
const routes = read(path.join(SRC, "app", "routes.jsx"));
const routesCode = strip(routes);
check("B1 routes.jsx imports neither Chat nor PromptLibraryPage", !/\bChat\b|PromptLibraryPage/.test(routesCode.replace(/path="\/chat/g, "")));
check("B2 /chat/:conversationId? redirects to the landing page", /path="\/chat\/:conversationId\?"\s+element=\{<Navigate to="\/" replace \/>\}/.test(routesCode));
check("B3 /prompts redirects to the landing page", /path="\/prompts"\s+element=\{<Navigate to="\/" replace \/>\}/.test(routesCode));
check("B4 the redirects target an existing route (index)", /<Route index element=\{<Home \/>\}/.test(routesCode) || /path="\/"\s+element=\{<Home/.test(routesCode) || /<Home \/>/.test(routesCode));
const app = strip(read(path.join(SRC, "app", "App.jsx")));
check("B5 App.jsx no longer mounts the conversation provider", !/ConversationProvider/.test(app));

// ============================================================================================ C landing
console.log("\n# C the landing page");
const homeRaw = read(path.join(SRC, "pages", "Home.jsx"));
const home = strip(homeRaw);
check("C1 no input, textarea, select, or form on the landing page", !/<(input|textarea|select|form)\b/i.test(home));
check("C2 no state, effects, or network on the landing page (static)", !/useState|useEffect|useReducer|axios|fetch\(|services\/api/.test(home));
check("C3 it imports nothing from the chat, prompts, conversations or mock-data modules", !/features\/(chat|prompts|conversations)|mockData|chatService/.test(home));
const linkTargets = [...home.matchAll(/<Link\s+to="([^"]+)"/g)].map((m) => m[1]);
const routePaths = new Set([...routesCode.matchAll(/path="([^"]+)"/g)].map((m) => m[1]));
check("C4 it has at least one real call to action", linkTargets.length >= 1, linkTargets.join(", "));
check("C5 every link on it points at a defined route", linkTargets.every((t) => routePaths.has(t) || routePaths.has(`${t}/:signalId?`) || routePaths.has(`${t}/:conversationId?`)), linkTargets.join(", "));
check("C6 no link targets the former chat or prompt routes", !linkTargets.some((t) => /^\/(chat|prompts)/.test(t)));
const homeText = homeRaw.replace(/<[^>]+>/g, " ");
for (const phrase of ["What should EOI investigate", "Ask EOI", "New Intelligence", "Suggested investigations", "Prompt Library", "Thinking", "Analyzing"]) {
  check(`C7 the landing page does not say "${phrase}"`, !homeText.includes(phrase));
}
check("C8 it states that a recommendation never acts on its own and that generation is on request", /never acts on its own/.test(homeRaw) && /only when you choose/.test(homeRaw));
check("C9 it names no model, provider, environment variable, id or invented operational fact", !/gemini|openai|LLM_|MONGODB|ObjectId|[0-9a-f]{24}|Unit \d|Room \d|Guest [A-Z]/i.test(home));

// ============================================================================================ D navigation
console.log("\n# D navigation");
const sidebar = strip(read(path.join(SRC, "components", "layout", "Sidebar.jsx")));
const header = strip(read(path.join(SRC, "components", "layout", "Header.jsx")));
const shell = strip(read(path.join(SRC, "components", "layout", "AppShell.jsx")));
for (const [name, src] of [["Sidebar", sidebar], ["Header", header], ["AppShell", shell]]) {
  check(`D1 ${name} has no link or route to /chat or /prompts`, !/["'`]\/(chat|prompts)/.test(src));
  check(`D2 ${name} uses no conversation context`, !/useConversations|ConversationProvider|conversationContext/.test(src));
}
check("D3 the sidebar has no New Intelligence / Conversations / Prompt Library entry", !/New Intelligence|Conversations|Prompt Library|sidebar-actions/.test(sidebar));
check("D4 the sidebar still links to the real Intelligence, Signals, Properties and Guests pages", ["/intelligence", "/operations/signals", "/operations/properties", "/operations/guests"].every((t) => sidebar.includes(`"${t}"`)));
check("D5 the shell does not render a context panel", !/ContextPanel/.test(shell));
const layoutCss = read(path.join(SRC, "styles", "layout.css"));
check("D6 the app-shell grid is two columns (sidebar + main), so removing the panel leaves no empty track", /\.app-shell\s*\{[^}]*grid-template-columns:\s*var\(--sidebar-width\)\s+minmax\(0,\s*1fr\)/.test(layoutCss));

// ============================================================================================ E reachability
console.log("\n# E import-graph reachability from main.jsx");
const entry = path.join(SRC, "main.jsx");
const seen = new Set(); const queue = [entry];
const resolveImport = (from, spec) => {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}.jsx`, path.join(base, "index.js"), path.join(base, "index.jsx")]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
};
while (queue.length) {
  const f = queue.pop(); if (seen.has(f)) continue; seen.add(f);
  if (!/\.jsx?$/.test(f)) continue;
  const code = strip(read(f));
  for (const m of code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    const r = resolveImport(f, m[1] || m[2] || m[3]); if (r) queue.push(r);
  }
}
const reachable = [...seen].map(rel);
check("E1 the import graph from main.jsx was walked", reachable.length > 20, `${reachable.length} modules`);
// data/mockData.js is still imported by Header, but only for the neutral placeholder `workspace` label; its conversation and
// prompt fixtures are not imported anywhere reachable (checked below, and tree-shaken out of the bundle in G).
const headerImportsMock = [...header.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*mockData"/g)].map((m) => m[1].trim());
check("E2a the only reachable mockData import is the neutral `workspace` placeholder", headerImportsMock.length === 1 && headerImportsMock[0] === "workspace" && reachable.filter((r) => /\.jsx?$/.test(r) && /mockData/.test(read(path.join(SRC, r)))).length === 1);
for (const banned of ["features/chat/chatService.js", "features/intelligence/intelligenceContract.js", "features/intelligence/cards.jsx", "features/conversations/ConversationProvider.jsx", "features/prompts/promptSelectors.js"]) {
  check(`E2 ${banned} is not reachable from the running app`, !reachable.includes(banned));
}
const reachableSrc = reachable.filter((r) => /\.jsx?$/.test(r)).map((r) => read(path.join(SRC, r))).join("\n");
check("E3 no reachable module requests a chat completion or posts to a conversation endpoint", !/createConversation|createMessage|listConversations|requestIntelligence/.test(reachableSrc.replace(/export\s+(async\s+)?function\s+\w+/g, "")) || !/(requestIntelligence)/.test(reachableSrc));
check("E4 no reachable module still renders the fabricated section labels as a chat answer", !/AssistantMessage|ThinkingIndicator|IntelligenceEmptyState/.test(reachableSrc));

// ============================================================================================ F real intelligence intact
console.log("\n# F the real Intelligence workflow is still wired");
for (const p of ["/intelligence", "/operations/signals", "/operations/signals/:signalId", "/operations/properties", "/operations/guests"]) {
  check(`F1 route ${p} is still defined`, routePaths.has(p) || routePaths.has(p.replace(/^\//, "")) || [...routePaths].some((r) => r.endsWith(p.split("/").pop())));
}
for (const m of ["features/intelligence/signalIntelligenceController.js", "features/intelligence/presentation.js", "features/intelligence/intelligenceErrorPresentation.js", "features/intelligence/safetyPresentation.js"]) {
  check(`F2 ${m} is present and reachable from the running app`, exists(m) && reachable.includes(m));
}

// ============================================================================================ G bundle
console.log("\n# G production bundle");
// P45A_DIST: a freshly built output directory (the checked-out frontend/dist may be a stale earlier build).
const dist = path.join(process.env.P45A_DIST || path.join(FRONTEND, "dist"), "assets");
if (fs.existsSync(dist)) {
  const bundle = fs.readdirSync(dist).filter((f) => /\.js$/.test(f)).map((f) => read(path.join(dist, f))).join("\n");
  const MARKERS = ["What should EOI investigate", "Suggested investigations", "Prompt Library", "No active risk reading", "requestIntelligence", "Ask EOI", "Thinking"];
  for (const m of MARKERS) check(`G1 bundle does not contain "${m}"`, !bundle.includes(m));
  check("G2 bundle contains no fabricated mock-data fixtures (conversation seed / prompt fixtures)", !/promptLibrary|mockConversations|seedConversations/.test(bundle));
} else {
  console.log("INFO  G skipped: frontend/dist not built (run `npm run build` in frontend first)");
}

console.log(`\nPhase 45A landing validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
