# MongoDB Atlas integration (Phase 41)

> **Configuration update (environment cleanup).** There is now ONE runtime environment file per service. The separate `backend/.env.atlas` described below no longer exists: the Atlas `MONGODB_URI` lives in `backend/.env`, and the Atlas tooling under `scripts/phase41/` reads it from there by default. Because `backend/.env` now holds the real URI, any process with `NODE_ENV=test` refuses to connect to a non-loopback database (`connectDatabase`), and validation runs must be given their own local `MONGODB_URI`. Wherever this document says `.env.atlas`, read `.env`.

Scope: connecting the backend safely to a MongoDB Atlas cluster. Nothing here deploys anything or configures hosting, OAuth or DNS. No secret is documented: every
connection string below is a placeholder, and the real one is supplied through environment or secret management only.

## 1. How the application uses MongoDB today

* **One variable, `MONGODB_URI`**, read by `src/config/env.js` (`dotenv` loads `backend/.env`; a variable already in the process environment always wins over `.env`).
  There is no second variable for the database name, TLS or credentials: all of it lives in the URI.
* `src/config/database.js` calls `mongoose.connect(uri)` with the driver defaults (pool size, 30 s server selection, TLS decided by the URI). A missing URI is an error.
* **Fail closed:** missing URI -> refuses to start; outside development/test a URI that is malformed or **names no database** refuses to start (otherwise the driver would use
  the default `test` database); no credentials or no TLS only warn (`mongoConfigProblems`, `src/config/startupChecks.js`, evaluated by `server.js` before connecting; messages never echo the URI).
  A connection failure (DNS, network, authentication) stops start-up with exit code 1. There is no fallback to any other database.
* **Indexes:** declared on the Mongoose models and built by Mongoose **autoIndex** when the backend connects. There are no migrations and no seed on start-up; nothing is dropped
  or rewritten. 84 distinct indexes are declared (17 unique/idempotency, 41 workspace-prefixed, 4 on `AnalysisAdmission`; the full table is in `PRODUCTION_ENVIRONMENT_CONTRACT.md`).
* **Tests** never use the development or an Atlas database for destructive work: they create throwaway databases (`koi_p3*`, `koi_p4*`) or workspaces they remove by id.

## 2. Two environments, never mixed

| Environment | `MONGODB_URI` | Where it lives |
|---|---|---|
| LOCAL DEVELOPMENT | `mongodb://127.0.0.1:27017/koi` (the local instance) | `backend/.env` (git-ignored) |
| ATLAS (staging / production) | `mongodb+srv://<db-user>:<password>@<cluster-host>/<database>?retryWrites=true&w=majority` | the hosting platform's secret store; for a one-off local check, an ignored file such as `backend/.env.atlas` (covered by the `.env.*` rule) |

Rules: never put the Atlas URI in source, a tracked file, a frontend variable (`VITE_*` is public and inlined into the bundle) or a log; never replace the local value in `backend/.env`
to test Atlas (export the Atlas value for that one process instead); the database name is **part of the URI** (required outside development/test).

Local: leave `backend/.env` as it is (`MONGODB_URI=<local development value>`). Atlas, for a one-off local run without touching `.env`:

```bash
export MONGODB_URI="$(sed -n 's/^MONGODB_URI=//p' backend/.env.atlas)"   # nothing is printed
node backend/server.js                                                    # the exported value overrides backend/.env
```

## 3. What Atlas must provide

| Requirement | Detail |
|---|---|
| Database user | a **dedicated** user for this application with a custom role of **`readWrite` on the one application database** only. Not `atlasAdmin`, not `readWriteAnyDatabase`, not an owner/admin user. The index build needs `createIndex` on that database, which `readWrite` includes (`dbAdmin` on the same database is optional). |
| Password | long and random, stored only in the secret store; rotate it if it was ever pasted into a chat, ticket or log. Characters such as `@ : / ? # [ ] %` must be percent-encoded in the URI. |
| Database name | chosen deliberately (for example `koi_staging`, `koi_production`) and placed in the URI path; one database per environment. |
| Network access | Atlas **Network Access -> IP Access List**: add only the addresses that must connect. For a development machine, add its single public IP **temporarily** and remove it afterwards. **Do not use `0.0.0.0/0`** (open to the internet) unless explicitly decided later. A hosting platform without a fixed egress IP cannot be allow-listed narrowly: use a platform feature that gives a static egress IP, or Atlas private networking / peering (a paid-tier feature), and record the choice. |
| TLS | always on: `mongodb+srv://` implies TLS and the application refuses nothing less in production (`tls=true` is required for a plain `mongodb://` URI). |
| Authentication | SCRAM user/password (X.509 or IAM-based auth are not used by the application). |
| Backups | free shared tiers do not give the continuous/cloud backup of paid tiers: verify the cluster tier, enable backups with a retention period, and **prove a restore** (see `DEPLOYMENT_PREFLIGHT_PHASE39.md`). |

## 4. Index initialisation behaviour

* On an **empty** database the first backend start creates every collection's indexes (autoIndex). The first requests can arrive while an index is still building; for an empty database
  this takes well under a second.
* On a database that **already holds data** the application only ever *adds* missing indexes; it never drops or alters one. A unique index cannot be built over documents that already
  violate it: that is reported by the driver and must be resolved by a human, never by deleting data blindly.
* Verify any database read-only with `node backend/scripts/phase41/atlas-indexes.mjs` (REQUIRED INDEX / EXPECTED / ACTUAL / STATUS). It never changes anything.

## 5. Safe connectivity verification (read-only, prints no credential, URI or host name)

```bash
node backend/scripts/phase41/atlas-preflight.mjs          # DNS, TLS, authentication, version, roles, databases, collections, document counts
node backend/scripts/phase41/atlas-indexes.mjs            # required vs actual indexes
```

Failure messages are mapped to a fixed category: *authentication failed* (user, password or database access), *cannot reach the cluster* (almost always this machine's IP is not in the
Atlas IP Access List, or the cluster is paused), *TLS failure* (a TLS-inspecting proxy), *DNS failure* (wrong host in the URI).
A one-time synthetic write test that creates and removes only its own records, and refuses to run unless the application database is empty, is `atlas-synthetic-test.mjs`
(it needs a backend started against Atlas; see the script header). It makes no Gemini call.

## 6. Findings from the Phase 41 check (a staging cluster supplied for this phase)

* Connected on the first attempt over TLS with a valid user; server 8.0.x; replica set; the cluster held only `admin` and `local`, so the application database did not exist and was empty.
* **The user supplied held the `atlasAdmin` role.** That is far broader than the application needs. Create the `readWrite`-on-one-database user from section 3 and use it instead.
* **The password was pasted into a chat.** Treat it as exposed and rotate it when the least-privilege user is created.
* The connection string had no database name; the application requires one outside development, so a name (`koi_staging`) was added to the URI used for the check. Choose the real name deliberately.
* Which Network Access entries exist could not be seen from the application; verify that no `0.0.0.0/0` entry is present.

## 7. Still required before any deployment

Least-privilege user; narrow network access (and a plan for hosting egress); backups and a proven restore; the production URI in the hosting platform's secret store; the
production database name; OIDC and hosting are separate phases. This document does not claim any of that is done.

## 8. Phase 41.1: least-privilege user, rotation and network access (manual Atlas steps)

The Atlas connector available to the assistant was **disabled by the Atlas organization** (an Organization Owner must enable AI client access), and even when enabled it only
lists and inspects (organizations, projects, clusters, database users, the IP access list, alerts) and queries data: it **cannot create or delete database users, change roles,
rotate a password or edit the IP access list**. These steps therefore remain manual, in the Atlas UI (Database Access / Network Access):

1. **Database Access -> Add New Database User.** Authentication: password (use *Autogenerate*). Database User Privileges: **Specific Privileges** -> Role `readWrite`, Database `koi_staging`,
   and nothing else (no built-in `Atlas admin`, no `Read and write to any database`, no `dbAdmin`). Restrict it to your cluster. Give it a new name, not the old one.
2. Put the new connection string (database `koi_staging` in the path) into the ignored `backend/.env.atlas`, replacing the old line. Do not paste it into chat.
3. Run `node backend/scripts/phase41/atlas-credential-verify.mjs`. It must report **PASS**: exactly one role (`readWrite@koi_staging`), no privilege outside that database, reads of
   `admin`, `local` and other databases denied, only the application database visible. Then re-run `atlas-preflight.mjs` and `atlas-indexes.mjs` (84 of 84 indexes expected).
4. **Only after that works,** delete the old `atlasAdmin` application user (Database Access -> Delete). That invalidates the credential that was pasted into a chat. Keep a separate
   Atlas *project/organization* account for administration; database users are not the administrators of the Atlas project.
5. **Network Access:** list the entries. Delete any `0.0.0.0/0` entry. Keep one entry for your current public IP (label it temporary) and add each hosting egress IP only when a deployment exists.
   Check that you can still connect (`atlas-preflight.mjs`) before removing the last broad entry.
6. **Cluster -> Backup:** confirm whether backups are available on your tier and enabled; a restore is an operations task and is not verified here.
