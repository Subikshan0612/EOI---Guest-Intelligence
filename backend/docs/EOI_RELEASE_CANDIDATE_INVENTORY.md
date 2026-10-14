# EOI — Release Candidate Inventory

Date: 2026-10-14. Basis: the current working tree of the `EOI---Guest-Intelligence` repository after the Safety Posture + Context Quality work (PASS), the Deployment Readiness Audit (`EOI_DEPLOYMENT_READINESS_AUDIT.md`) and this release-candidate hardening.

**Nothing was committed, staged, pushed or deployed. No external system was modified.** The exact file list is in `EOI_RELEASE_CANDIDATE_MANIFEST.txt` (same folder).

## FINAL RELEASE GATE: **RELEASE CANDIDATE READY WITH DOCUMENTED RISK**

None of the disqualifying conditions applies: no new test regression, the critical advisory is fixed, the Python install is reproducible, Node is pinned, the CORS trailing-slash trap is closed, no secret is in the release set, and the inventory is complete. "With documented risk" because of the residual items in section 18 (chiefly: Node 20 is past its end of life, the AI service's FastAPI/Starlette generation has known advisories and must stay private, and the cleaned-up evaluation scripts are not fully reproducible without their excluded outputs).

How the result was verified: the exact release file set (646 files, section 1) was copied to a clean directory, initialised as a throwaway git repository, installed from the lockfiles (`npm ci` twice, a fresh Python 3.12.6 virtual environment from `requirements-dev.txt` + `constraints.txt`) and tested there, in addition to the checks in the working repository.

---

## 1. Files intended to ship

**646 files**, listed one per line in `EOI_RELEASE_CANDIDATE_MANIFEST.txt` section [1] (`NEW`, `MODIFIED`, `unchanged`). The final manifest was verified in a throwaway clone (section 19). Earlier, `git add -A` in a clean copy (a throwaway repository outside the working tree) staged the then-654-file set, with the .gitignore rules in force; one tracked file, `frontend/src/data/mockData.js`, had been hidden by the old `data/` rule and was force-added there, which is why the rule is now `/data/` (in the real repository that file is already tracked).

| Area | New | Modified | Unchanged | Total |
|---|---|---|---|---|
| backend/src (production source) | 85 | 59 | 27 | 171 |
| backend/scripts `validate-*` suites | 81 | 17 | 3 | 101 |
| backend/scripts operator / verification / evaluation tooling (source only) | 57 | 3 | 0 | 60 |
| backend/evaluation harness (inputs and code, no results) | 26 | 0 | 0 | 26 |
| backend/docs | 58 | 0 | 0 | 58 |
| backend configuration (package*, server, app, `.env.example`, `.node-version`) | 1 | 6 | 0 | 7 |
| frontend/src (production source) | 82 | 21 | 37 | 140 |
| frontend configuration (package*, `vercel.json`, `.node-version`) | 2 | 3 | 5 | 10 |
| ai-service/app (production source) | 14 | 11 | 14 | 39 |
| ai-service/tests | 16 | 2 | 6 | 24 |
| ai-service configuration (requirements, constraints, pins, README) | 3 | 3 | 1 | 7 |
| repository root (`.gitignore`, `CLAUDE.md`, ...) | 0 | 1 | 2 | 3 |
| **Total** | **425** | **126** | **95** | **646** |

(Counts are the manifest's; "unchanged" files are already in git.)

**Removals to ship (27 tracked files deleted in the working tree)**, listed in manifest section [2]: the retired Node provider modules (`llmProvider.js`, `intelligencePrompt.js`, `intelligenceSchema.js`), `validate-intelligence.mjs`, and 23 retired frontend files (the old chat, prompt-library and signal pages). Nothing imports them (the frontend builds and every suite that passed before still passes).

## 2. Files intentionally excluded

Manifest section [3] lists all **587** excluded files (the 579 ignored/protected ones plus the 8 reviewed files below); section [4] summarises tool caches. By category:

| Category | Where | Files | Reason |
|---|---|---|---|
| TEST_ARTIFACT — captured model outputs, scores, logs of evaluation runs | `backend/scripts/phase53/out*/` (except two freeze records), `backend/scripts/l14/out/`, `backend/scripts/phase41/out/` | ~550 | captured Gemini output; regenerable; not needed to run anything |
| TEST_ARTIFACT — captured evaluation results incl. a 3.4 MB embedding cache | `backend/evaluation/results/` | 19 | same |
| TEST_ARTIFACT — generated diagram delivery / browser-check records | `docs/architecture/*.json` | 9 | generated |
| SCRATCH/TEMP — compiled caches | `__pycache__/`, `*.pyc` | 2 untracked + caches | |
| **DO_NOT_SHIP (decided, review of the 11 files)** — 6 superseded or unrunnable Phase 53 evaluation scripts and the 2 architecture diagram pages | `backend/scripts/phase53/{rubric,score,rubric2.selftest,run-benchmark,run-benchmark2,run-benchmark3}.mjs`, `docs/architecture/0{1,2}-eoi-*-architecture.html` | 8 | nothing depends on them (no production code, no suite imports or reads them); the first six need excluded outputs or a real Gemini run and are superseded (`run-benchmark3` also starts a backend with the Learning flag ON); the pages are a 2026-10-06 snapshot that still says no Vercel/Render target exists and that Atlas is not connected. They stay **untracked and NOT ignored** in the working tree: stage from the manifest, never with a blanket `git add -A`. |
| **DO_NOT_SHIP (decided)** — protected, machine-specific local tooling | `.claude/launch.json` | 1 | a Windows-only (`cmd /c`, `.venv\Scripts\python.exe`) development preview configuration for the local AI service (test providers), backend (port 5000) and frontend (port 5174); no secret, but not part of the application and meaningless on Render/Vercel. The file is untouched and stays untracked. It is **not** covered by any ignore rule, so a blanket `git add -A` would stage it: stage by the manifest, or exclude it explicitly (`git add -A -- . ':!.claude'`), or add `.claude/` to your local `.git/info/exclude` (a per-clone file, not part of the repository). |
| DO_NOT_SHIP — real environment and secrets files (already git-ignored) | `backend/.env`, `ai-service/.env`, `frontend/.env`, `backend/evaluation/learning-real-lite/.env.lite` | 4 | credentials |
| DO_NOT_SHIP — local data and developer outbox (already git-ignored) | `data/` (dummy guests, SOP), `backend/.dev-outbox/` | 4 | operational/dummy data, one-time links |
| Dependency and build directories (already ignored) | `node_modules`, `.venv`, `dist`, `.pytest_cache` | — | |

New `.gitignore` rules (root) make `git add -A` safe: they ignore the evaluation output directories (keeping the two freeze records `phase53/out2/rubric2.sha256` and `out3/rubric3.sha256` that `validate-learning-l1-4-effectiveness` checks), `docs/architecture/*.json`, `__pycache__/` and `*.pyc`, and narrow `data/` to `/data/` (the old rule would have hidden any new file in `frontend/src/data/`).

## 3. Release classification of every changed/untracked item (before and after)

Of the 1,133 working-tree entries when this workstream started (`git status -uall`): **TEST_ARTIFACT 554**, **DOCUMENTATION 56**, **LEGACY/OBSOLETE 27** (the removals), **NEEDS_REVIEW 11** (since decided: 3 SHIP, 8 DO_NOT_SHIP), **SCRATCH/TEMP 2**, **DO_NOT_SHIP 1** (`.claude/launch.json`), and **SHIP 482** (source, tests, tooling, configuration); 95 already-committed unchanged files plus this workstream's own files complete the **646**.

**NEEDS_REVIEW (11) — all 11 decided.** *SHIP (3):* `backend/scripts/phase53/rubric3.selftest.mjs` (pure synthetic check of the shipped rubric v3; 31 checks pass on a clean checkout), `backend/scripts/phase53/run-e2e-53d.mjs` (loopback-only real-Gemini end-to-end smoke harness with governance checks, Learning forced off; same class as the shipped `phase40/e2e-acceptance.mjs`), `backend/scripts/l14/score4.mjs` (the scorer of the frozen L1.4 dataset4/rubric4/score4 set, named by the shipped L1.4 report). *DO_NOT_SHIP (8):* see the row in section 2. None of the 11 contains a secret or machine-specific data; none is used by production code or imported by a test.

## 4. New / modified production source files

All production source in the manifest is part of the release; the tree is far ahead of the last commit (see the audit). This workstream itself changed these production files: `backend/src/config/startupChecks.js` and `backend/server.js` (the two new start-up guards, section 8). No other production source file was touched. Earlier workstreams' production changes (analysis lifecycle, safety hardening, recurrence, `SAFETY_REVIEW_REQUIRED`) are verified, and unchanged here.

## 5. Dependency changes

| Where | Change | Reason |
|---|---|---|
| backend (npm) | `proxy-addr` 2.0.7 → **2.0.8** (lockfile only; `npm update proxy-addr`; no other package changed; `express` stays 5.2.1) | critical advisory GHSA-jqcg-44mw-7w3h (client-IP spoofing through an IPv4-mapped IPv6 trust subnet) |
| backend (npm) | `mammoth` 1.12.3 **unchanged**; the audit's only offered fix is a breaking downgrade to 0.3.29 | see section 11 |
| ai-service (pip) | `requirements.txt`: `pydantic==2.10.4` → **`2.13.5`**; `pytest` moved to the new `requirements-dev.txt`; `httpx` listed (the app imports it) | the pin did not match the version the suite was tested on |
| ai-service (pip) | new `constraints.txt` pinning all 39 installed packages (+ `uvloop`, Linux only); `urllib3` **2.8.0** (tested set had 2.7.0) | reproducibility; urllib3 advisories PYSEC-2026-4175/-4176/-4177 |
| frontend (npm) | none | |

## 6. Runtime version pins

| What | Pin | Basis |
|---|---|---|
| Node (backend) | `engines.node` `>=20.17.0 <21` and `backend/.node-version` `20.17.0` | the runtime every suite and the real-Gemini run used today is 20.17.0; no dependency requires another |
| Node (frontend build) | `engines.node` `20.x` and `frontend/.node-version` `20.17.0` | built and tested on 20.17.0; `20.x` is the form Vercel documents |
| Python (AI service) | `ai-service/.python-version` `3.12.6` | the interpreter of the passing run |

Note (section 18): Node 20 is past its published end of life. It was pinned because it is the verified runtime; moving to a current LTS is a separate, tested change.

## 7. AI-service dependency reproducibility — result

- Tested environment (the old `.venv`): 39 packages; `requirements.txt` disagreed on `pydantic` (2.10.4 vs 2.13.5).
- New clean virtual environment from `requirements.txt -c constraints.txt`: installs exactly the 35 production packages at the tested versions (`pip freeze` identical to the tested freeze minus `pytest`, `pluggy`, `iniconfig`, `packaging`); `pip check`: no broken requirements.
- Full suite in the clean release copy (cross-service tests read `backend/`): **531 passed** — before and after the `urllib3` 2.8.0 bump. The final clean install (`requirements-dev.txt`) matches every pin and passes 531.
- Linux resolution (the Render platform): `pip install --dry-run --platform manylinux…` with the constraints resolves 35 packages, every one at its pinned version. `uvloop` 0.23.0 has a cp312 Linux wheel but **could not be exercised on this Windows machine** — verify at the first Linux start.
- `pip-audit` on the pinned production set: `urllib3` clean after the bump; `starlette` 0.41.3 advisories remain (section 11).

## 8. Configuration validation changes

| Trap | Before | After |
|---|---|---|
| `CLIENT_URL=https://app.example.com/` (trailing slash, path, query, fragment, credentials, upper-case host, default port, whitespace, wrong scheme, empty, `null`) | passed start-up, failed every browser request at CORS | **production and an unset/unknown `NODE_ENV` refuse to start** (`clientUrlProblems`; message names the rule, never the value); development/test: warning; the preflight FAILs it. HTTPS and non-localhost rules are untouched. |
| `KOI_TRUST_PROXY=true`, `0`, `11`, `1.5`, typos | silently ignored (every user on one rate-limit key behind a proxy) | **refuses to start** in production/unknown (`trustProxyProblems`); warning in dev/test; preflight FAILs |
| `AI_SERVICE_TOKEN` absent | startup warning, preflight WARN | runtime unchanged (warning); **preflight FAILs** it (release requirement for the Vercel → Render → private AI service topology); contract updated |

Already enforced (verified by the new suite section E, no code added): production HTTPS `CLIENT_URL` (when e-mail is needed), required SMTP with `AUTH_PROVIDER=eoi`, required production AI URL, forbidden development/stub auth, forbidden outbox transport, forbidden test providers and provider typos, Learning enabled reported (and preflight FAIL), Gemini key absent from Node (preflight), database name required, invalid timeout combinations fatal. Deliberately **not** added: a fatal `AI_SERVICE_TOKEN`, a keep-alive/headers-timeout rule and a fatal Learning flag (each would change documented behaviour or rests on platform behaviour that cannot be proved here).

## 9. Test results

**New suite** `validate-release-config-guards.mjs`: **37 passed, 0 failed** (CLIENT_URL forms, trust-proxy values, the real server process refusing and passing, preflight mutations, coverage of the other traps).

**Clean release copy, full backend sweep (101 suites): 68 exit 0, 33 non-zero. NEW REGRESSION: none.**

| Group | Result in the clean copy |
|---|---|
| Safety: `safety-review-required` 56, `safety-context-hardening` 46, `phase43a` 39, `43b` 34, `43b1` 47, `43b2` 48, `43c` 48, `43d` 39, `phase34-provider-policy` 55, `34c` 58, `34d` 49 | all pass |
| Analysis lifecycle: 5A 46, 5B 72, 5C 46 | all pass |
| Learning (OFF): L1.3 61, L1.4 60, L1 case-based 63, L1 replay 18, `learning` 90, `learning-patterns` 119 | all pass |
| Decision / Action / Outcome: `decision` 42, `decision-v1` 145, `decision-authorization` 132, `action` 76, `outcome` 73, `phase48` 45, `48.1` 17, `phase49` 49, `phase50` 44 | all pass |
| Intelligence / RAG: `phase25` 78, `phase28` 64, `phase52` 39, `phase53d` 38, `knowledge-visibility` 103 | all pass |
| Security / readiness: `phase19-route-inventory` 1013, `phase21` 248, `phase23-oidc` 137, `security-boundary` 83, `phase36` 68, `phase37` 40, `phase39-preflight` 58, `ai-provider-observability` 29 | all pass |
| AI service (pytest, clean venv) | **531 passed** |
| Frontend `npm run build` (clean `npm ci`) | succeeds, 5.1 s |

Stack-dependent suites, run against a throwaway local stack (test AI service, stub auth) in the clean copy: `validate-api` 261, `validate-import` 195, `validate-ai-service` 24, `validate-intelligence-persistence` 64, `validate-intelligence-analysis-api` 81, `validate-knowledge-*` (authoring 49, chunking 54, embedding 42, grounding 46, ingestion 86, ingestion-upload 158, retrieval 106, visibility-api 144, base 54), `validate-phase24` 60 — **all pass**.

Compared with the Phase 5C baseline: no suite that was green lost a check, apart from the three environment-dependent Google/onboarding suites explained in section 10 (they pass in the repository checkout); `ai-provider-observability`, `phase45b22-auth-hardening` and `phase52-correctness` moved from red to green; `phase41` improved (27/2 → 28/1) because the Atlas user name was removed from a script comment.

## 10. Known baseline failures — classification of every non-zero suite

Classes: **NEW REGRESSION** (none) / **KNOWN BASELINE FAILURE** / **STALE EXPECTATION** / **ENVIRONMENT DEPENDENCY**.

| Suite (clean copy result) | Class | Reason |
|---|---|---|
| `validate-ai-service`, `validate-api`, `validate-import`, `validate-intelligence-analysis-api`, `validate-intelligence-persistence`, `validate-knowledge` (+ `-authoring`, `-chunking`, `-embedding`, `-grounding`, `-ingestion`, `-ingestion-upload`, `-retrieval`, `-visibility-api`), `validate-phase24-canonical-intelligence` (16 suites) | ENVIRONMENT DEPENDENCY | need a running backend and AI service; all pass against the throwaway stack (previous paragraph); red in the 5C baseline for the same reason |
| `validate-dev-token`, `validate-provision-dev-identity` | ENVIRONMENT DEPENDENCY (also red in 5C) | refuse to run unless `NODE_ENV` is development/test; the sweep runs without it |
| `validate-phase26-evaluation`, `validate-phase26_5-real-embedding` | KNOWN BASELINE FAILURE | `PROVIDER_ROUTE_NOT_APPROVED` / need real-embedding artefacts; red in 5C (the captured cache is deliberately not shipped) |
| `validate-phase27` 111/2, `phase29` 83/2, `phase30` 73/2, `phase31` 57/2, `phase32` 54/2 | KNOWN BASELINE FAILURE | the "database equals the documented baseline" checks fail because the shared local `koi_boot` database holds leftovers; identical counts in 5C |
| `validate-phase33-lite-evaluation` (stops early in a clean copy; 76/2 in the repository) | KNOWN BASELINE FAILURE (+ ENVIRONMENT DEPENDENCY) | the same 2 checks as 5C; needs the ignored `.env.lite` key |
| `validate-phase33-real-learning-evaluation` 27/1 | KNOWN BASELINE FAILURE | check B (a mutation script mentions a real-Gemini call); same as 5C; 2 fewer passes only because the excluded results folder is absent |
| `validate-dashboard` 77/1 | STALE EXPECTATION | asserts the dashboard detail has no `safety` field (added in 43B.1); red in 5C |
| `validate-phase38-deployment-readiness` 78/1 | STALE EXPECTATION | D5 says the repository has no deployment manifest; `frontend/vercel.json` now exists |
| `validate-phase41-atlas-readiness` 28/1 | STALE EXPECTATION | C3's allow-list does not cover two synthetic fixtures (`validate-database-safety`, `validate-phase43d`); C6 (Atlas credentials) now passes |
| `validate-phase45a-landing` 68/6 | STALE EXPECTATION | asserts routes and landing wording removed in Phase 47; red in 5C |
| `validate-phase45b4-google-oidc` 76/1, `validate-phase45b41-google-ui-runtime` 37/4 | ENVIRONMENT DEPENDENCY | verify the developer's real local Google profile (`backend/.env`, `frontend/.env`) which a clean copy does not have; in the repository checkout: **80/0 and 44/0** (also after the edit in section 12) |
| `validate-phase45c-account-onboarding` 36/1 | KNOWN BASELINE FAILURE (intermittent C6) | passes on rerun: 37/0 |

## 11. Security scan, npm audit, pip audit

- **Release-set secret scan** (re-run on the final 646 files in section 19; first run on 654; patterns plus the exact values of every secret-shaped variable in the three real `.env` files and `.env.lite`): **no real secret**. Findings were synthetic fixtures only (`AIza-not-a-real-key…`, `.invalid`/`example` URIs, throwaway test passwords). No `.env` file (only the three `.env.example` templates). No Atlas host, user, password, Gemini key, Google secret, SMTP password, AI-service token or session secret. No raw guest data (the 10 contact values of the dummy guest file occur nowhere). No capture/log/probe files. No file in the final set exceeds 500 KB (the two diagram pages were removed).
- **Fixed during the scan:** the Atlas application user name was in a comment of `backend/scripts/phase41/atlas-learning-replay-readonly.mjs` (now "the least-privilege application user"); the real Google OAuth client id was in the file name used by three suites (`client_secret_<id>.json`; now found by directory search). Neither was a secret; both are removed from the release.
- **Git history** (37 commits, all refs): no secret value and no secret-shaped string; no `.env` file ever committed.
- **`npm audit --omit=dev`** — backend: 3 moderate (`mammoth` → `argparse` → `sprintf-js`), **0 critical** (was 1 critical + 3 moderate); frontend: 0.
  - *mammoth decision:* the advisory (GHSA-hp3w-g68c-fv3c) is a denial of service through an unbounded precision specifier in `sprintf-js`, reached only through `argparse`. In `mammoth` 1.12.3 `argparse` is required only by the command-line tool `bin/mammoth`; the library entry point the application uses (`mammoth.convertToHtml({ buffer })` in `documentExtractor.js`) never loads it — verified by converting the project's real SOP document and observing that **no `argparse` or `sprintf-js` module is loaded**. The only fix npm offers is a breaking downgrade to 0.3.29 (an older converter). *Decision:* no change; residual risk accepted and documented (it would become relevant only if the command-line tool were run or `argparse` were imported by another path). Newer `mammoth` releases (1.13.0) still depend on `argparse`, so upgrading does not clear the report.
- **`pip-audit` on the pinned set:** after the `urllib3` bump only **`starlette` 0.41.3** remains (PYSEC-2026-161, -248, -249, -1941, -1942, -2280, -2281). `fastapi` 0.115.6 requires `starlette` <0.42, so the fix is a FastAPI upgrade (a behaviour-affecting change, not made here). Exposure: multipart/form parsing, `FileResponse` ranges, `StaticFiles` and `HTTPEndpoint` are **not used** by the service (JSON-only POST endpoints); two advisories concern how `request.url` is rebuilt from the Host header and request path, and the service-token middleware reads `request.url.path` — not assessed as exploitable here. *Mitigation:* the AI service must stay a **private** service (the token is defence in depth, not the only control), and the FastAPI/Starlette upgrade should be scheduled as its own tested workstream.
- **Repository environment preflight** on the synthetic production set: no FAIL; on the local development files: the same expected development-value FAILs plus the new rows; **bundle scan** of the clean production build: 3 PASS (no secret values, no credential-shaped strings, no development token).

## 12. Changes made in this workstream (complete list)

Backend: `src/config/startupChecks.js`, `server.js`, `scripts/phase39/env-preflight.mjs`, `package.json`, `package-lock.json`, `.node-version` (new), `scripts/validate-release-config-guards.mjs` (new), `scripts/validate-phase39-preflight.mjs` (the synthetic good set gains the service token), `scripts/phase41/atlas-learning-replay-readonly.mjs` (comment), `scripts/validate-phase45b4-google-oidc.mjs`, `validate-phase45b41-google-ui-runtime.mjs`, `validate-phase45c-frontend-onboarding.mjs` (client-secret file located by search instead of by a hard-coded name), `docs/PRODUCTION_ENVIRONMENT_CONTRACT.md` (three rows), this inventory and the manifest.
Frontend: `package.json`, `package-lock.json`, `.node-version` (new).
AI service: `requirements.txt`, `requirements-dev.txt` (new), `constraints.txt` (new), `.python-version` (new), `README.md` (install command).
Root: `.gitignore`.

## 13. Confirmations

1. **No `.env` or secret in the release set** — verified (section 11). The three templates are the only env files.
2. **`.claude/` and `CLAUDE.md` untouched** — `CLAUDE.md` is unmodified against git; `.claude/launch.json` still carries its 2026-09-28 timestamp, is classified DO_NOT_SHIP and is excluded. (`CLAUDE.md` is stale relative to the code — it still describes the retired `llmProvider.js` — but was not edited, as instructed.)
3. **Learning remains OFF** — the flag is unset in every environment file and process used; the suites that check it (L1.x, 43x, 5A–5C) pass; a `SAFETY_REVIEW_REQUIRED` case is excluded from Learning by its existing consistency rule.
4. **Safety semantics unchanged** — `safetyPolicy.js`, the Decision and Action services, recurrence and the analysis lifecycle were not edited; the 11 safety suites above pass in the clean copy.
5. **Gemini model, prompts, RAG, timeouts, retry policy** — unchanged.
6. **No external system modified** — no commit, push, deploy or platform call. Network use was read-only: npm and PyPI downloads, advisory databases. Atlas was never contacted: every database-touching process used a loopback URI or the repository's own guard refused to run; all test databases were local and throwaway.
7. **Git state** — nothing staged or committed. The only `git` write was in a throwaway copy outside the repository (`C:\koi-rc`, deleted at the end).

## 14. What you still decide before the first commit

1. ~~The 11 NEEDS_REVIEW files~~ — **decided** (section 3): 3 SHIP, 8 DO_NOT_SHIP.
2. ~~Whether `.claude/launch.json` should be in git~~ — **decided: DO_NOT_SHIP** (section 2); remember to keep it out when staging.
3. Whether to commit in one commit or in logical groups (the tree contains many phases of work that were never committed).
4. The Node 20 → current LTS question (section 18).

## 15. Reproduce the verification

```bash
cd <fresh checkout of the release commit>
cp backend/.env.example backend/.env && cp ai-service/.env.example ai-service/.env && cp frontend/.env.example frontend/.env   # 26 suites read backend/.env
cd backend && npm ci && cd ../frontend && npm ci && npm run build && cd ../ai-service
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt -c constraints.txt && .venv/Scripts/python -m pytest -q
cd ../backend && MONGODB_URI=mongodb://127.0.0.1:27017/koi_boot node scripts/validate-release-config-guards.mjs
```

Prerequisites of a clean checkout that are **test-infrastructure, not product, issues**: 26 `validate-*` suites read `backend/.env` unguarded (copy the template first), several use `git` (run inside a repository), the stack-dependent suites need the throwaway stack, and the Google profile suites need the developer's local Google settings.

## 16. Residual items for later (not blockers)

Stale expectations listed in section 10 (`dashboard`, `phase38 D5`, `phase41 C3`, `phase45a`); making the 26 suites tolerate a missing `backend/.env`; a CI definition (none exists).

## 17. Relation to the readiness audit

Closed by this workstream: A1–A3 only after you commit (the set is now defined and verified), A6, D4, D5, I2, P1 (critical advisory), C2. Still open exactly as in the audit: every item that needs Render, Vercel, Atlas, Google Cloud, SMTP or an owner decision (topology/domain, backups, alerts, runbook, consent screen, privacy basis).

## 18. Documented risks carried by this release candidate

1. **Node 20 is past end of life** (to the best of my knowledge April 2026; confirm on nodejs.org). It is the only runtime verified here. Plan a tested move to a current LTS before or soon after production; this is a version change that needs the full sweep on that runtime.
2. **mammoth chain** — 3 moderate advisories remain in the report; not reachable through the library API (section 11).
3. **starlette 0.41.3** advisories — the AI service must not be reachable from the internet; schedule the FastAPI upgrade.
4. **`uvloop` 0.23.0** is untested on Linux (pinned from dependency resolution).
5. **33 non-zero suites** are all classified (section 10), none is a regression, but there is no CI and four suites assert outdated facts.
6. **The 8 DO_NOT_SHIP files are still untracked and not ignored** in your working tree; a blanket `git add -A` would stage them (and `.claude/launch.json`). Stage from the manifest.
7. **`CLAUDE.md` is stale** against the current architecture (not edited by instruction).
8. The audit's external blockers remain until the platforms exist.

## 19. Final manifest integrity check (throwaway clone) — **PASS (20 of 20 checks)**

Method: a fresh `git clone` of the repository (a throwaway copy at `C:\koi-clone`, deleted afterwards; line-ending conversion off), the 27 deletions applied with `git rm`, every file of manifest section [1] copied from the working tree and staged with `git add`. The real repository was only read.

| Check | Result |
|---|---|
| Files in the release tree (index after staging) | **646** = the manifest's section [1] exactly, file for file |
| Staged against HEAD | **425 added + 129 modified + 27 deleted** = 581 changes; 92 further files are already committed and unchanged (425 + 129 + 92 = 646) |
| Staged deletions | **27**, identical to manifest section [2] |
| Renames, copies, type changes | 0 |
| `.claude/launch.json` / any `.claude/` path | absent from the index and from the clone |
| The 8 DO_NOT_SHIP files | absent; the 3 retained SHIP files (`rubric3.selftest.mjs`, `run-e2e-53d.mjs`, `l14/score4.mjs`) staged |
| `.env` files | none (the 3 `.env.example` templates only) |
| Staged files vs the real working tree | all 646 byte-identical |
| Stray untracked or unstaged files in the clone | none |
| Secret scan of the 646 staged files (patterns, 16 exact secret/credential values from the real `.env` files, git history, guest data, scratch files) | **0 findings** (only the known synthetic fixtures) |
| Real repository | nothing staged (0 files in the index diff), HEAD unchanged (`d94287f`), index fingerprint identical, no stash, no new refs, the 587-entry working-tree status list identical, `.claude/launch.json` and `CLAUDE.md` byte-identical |

Note on "129 modified": the manifest counts 126 MODIFIED and 95 unchanged. In the clone, 3 files that the real repository (with `core.autocrlf=true`) reports as unchanged show as modified, because they differ from the committed copy **only in line endings** (`validate-knowledge-section-path.mjs`, `knowledgeChunker.js`, `knowledgeEmbeddingService.js`; content identical after removing carriage returns). Staging in the real repository stages nothing for them.
