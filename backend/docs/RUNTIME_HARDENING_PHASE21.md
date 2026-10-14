# Runtime hardening - Phase 21

Validated by `backend/scripts/validate-phase21-runtime-hardening.mjs`.

## Request pipeline (order matters)

```
app:    cors -> securityHeaders -> anonymous limiter -> client-address limiter -> router
route:  authenticate -> identity limiters (user, write | ai | import) -> body (JSON parser | multipart) -> membership -> permission -> [ai workspace limiter]
```

There is **no app-level `express.json()`**. A JSON body is parsed only for an authenticated, not-yet-rate-limited caller
(`auth/authorize.js requireAccess`); uploads keep Phase 13's rule (authenticate, then limits, then the multipart parser).
Public routes (`GET /`, `GET /api/health`) carry no body handling. The one thing that still precedes authentication is
the client-address rate limit, deliberately: it rejects an unauthenticated flood without any body work.

## Rate limiting

Fixed-window counters behind a `RateLimitStore` interface (`middleware/rateLimit.js`). Only a **process-local**
`MemoryRateLimitStore` ships. That is correct for one process (development, tests) and **not production-grade** for a
multi-instance deployment: every instance keeps its own counters (the effective limit multiplies) and a restart resets them.
A production deployment must supply a shared store (for example Redis `INCR` + `PEXPIRE`) with `setRateLimitStore()`;
the server logs a warning at startup in production.

| Bucket (key) | Default / window | Variable |
|---|---|---|
| anonymous - no `Authorization` header (client address) | 60 | `KOI_RATE_LIMIT_ANON_MAX` |
| client address - every request | 900 | `KOI_RATE_LIMIT_IP_MAX` |
| identity - every authenticated request (`issuer|subject`) | 300 | `KOI_RATE_LIMIT_USER_MAX` |
| identity - writes (POST/PATCH/DELETE) | 60 | `KOI_RATE_LIMIT_WRITE_MAX` |
| identity - AI-reaching routes (shared bucket) | 10 | `KOI_RATE_LIMIT_AI_MAX` |
| verified workspace - AI-reaching routes (only permitted requests count) | 30 | `KOI_RATE_LIMIT_AI_WORKSPACE_MAX` |
| identity - operational imports | 5 | `KOI_RATE_LIMIT_IMPORT_MAX` |
| window | 60,000 ms | `KOI_RATE_LIMIT_WINDOW_MS` |
| store size guard | 200,000 keys | `KOI_RATE_LIMIT_MAX_KEYS` |
| enable/disable | enabled | `KOI_RATE_LIMIT_ENABLED` (only the string `false` disables) |
| trust `X-Forwarded-For` (hop count) | off | `KOI_TRUST_PROXY` |

Invalid values (non-numeric, zero, negative, out of range) fall back to the default; they never disable a limit.
AI-reaching routes: `POST /intelligence/analyze/:signalId`, `POST /signals/:id/intelligence`,
`GET /signals/:id/knowledge-retrieval`, `POST /knowledge-documents`, `POST /knowledge-documents/upload`,
`POST /knowledge-documents/:id/embeddings`.
Keys an attacker cannot change: the verified identity, the verified workspace, the socket address (forwarding headers are
ignored unless `KOI_TRUST_PROXY` is set). Changing a workspace id, body id, query value or header does not create a new bucket.
A 429 uses the existing contract (`details.code = RATE_LIMITED`) with `Retry-After`.
The development/test harnesses set `KOI_RATE_LIMIT_ENABLED=false` because they legitimately send thousands of requests from one
address; the Phase 21 suite proves the limiter with it enabled.

## Security headers (API responses only; the SPA keeps its own)

`X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (+ `Pragma`), `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
(safe: the API returns data, never pages), `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` (camera, microphone,
geolocation off), `Strict-Transport-Security` in production only. `X-Powered-By` is removed and ETag is disabled.
No CSP was applied to the Vite/React application.

## Timeouts

| What | Default | Variable |
|---|---|---|
| receive complete request headers (slow-loris) | 15 s | `KOI_HEADERS_TIMEOUT_MS` |
| receive complete request incl. body | 60 s | `KOI_REQUEST_TIMEOUT_MS` |
| idle socket | 120 s | `KOI_SOCKET_TIMEOUT_MS` |
| keep-alive | 5 s | `KOI_KEEPALIVE_TIMEOUT_MS` |
| how often Node enforces them | 5 s | `KOI_TIMEOUT_CHECK_INTERVAL_MS` |
| upstream AI call (Python service; OpenAI branch) | 20 s (the historical value) | `KOI_AI_TIMEOUT_MS` |
| JSON body size | 100 KB | `KOI_JSON_BODY_LIMIT_BYTES` |

The only outbound HTTP calls are the AI service client and the optional OpenAI branch; both use the upstream timeout, no retries.

## Import limits (refused before any write)

`KOI_IMPORT_MAX_ROWS` 5000, `KOI_IMPORT_MAX_COLUMNS` 50, `KOI_IMPORT_MAX_FIELD_LENGTH` 1000, `KOI_IMPORT_MAX_RECORD_BYTES` 20,000;
multipart parts are also bounded (1 file, 20 fields, 100 KB per text field). The parser stops one record past the row limit.

## Environment mode (fail closed)

`NODE_ENV` must be exactly `development` or `test` to allow the development token verifier, error `debug` details and the
development knowledge-level fallback. `production`, unset and unrecognised values refuse all three (unset/unknown also logs a
warning). With `NODE_ENV=test` the server refuses to start if `AI_SERVICE_URL` is not a loopback address or `LLM_PROVIDER=openai`
has an API key. Use `node backend/scripts/start-test-stack.mjs` to run the local test stack with forced test providers.

## Cross-workspace references

A valid id from another workspace now returns exactly what a nonexistent id returns (404, same message) for every referencing
endpoint (Stay, Signal, Conversation, KnowledgeDocument, legacy Decision, Import, Unit). A malformed id is still 400; a
same-workspace inconsistency (a Unit of another Property in the same workspace) is still 400.

## Not done here (later phases)

Real identity provider (OIDC), workspace lifecycle/deletion cascade, last-admin protection, a distributed rate-limit store.
