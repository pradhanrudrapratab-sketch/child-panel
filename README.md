# MrKrishna Child Panel – Minecraft Webstore

Node.js + Express + SQLite. One Child Panel = one storefront = **exactly one** Minecraft server.
No `.env` files: first run is configured from a setup wizard and the admin dashboard.

> ⚠️ **Read "Open items" at the bottom first.** The Main Panel API document and the existing plugin contract were not supplied
> with the source code, so the Main Panel paths / signature format are **placeholders** that must be confirmed (one JSON file, no code change).

## 1. Install & run

```bash
npm install          # express + better-sqlite3
npm start            # http://localhost:3000   (PORT env var is honoured on Render/Heroku-style hosts)
```
Requires Node 18.18+. Optional: `node server.js --data /var/data --port 8080`.

The first start creates the data folder (mode 0700) — by default **`/tmp/childpanel`** (system temp dir), no flags needed — containing:

| File | What |
|---|---|
| `panel.db` | SQLite database (WAL mode) |
| `secret.key` | auto-generated AES-256 key that encrypts secrets stored in the DB (Main Panel secret, Discord secret, bot token) |
| `contract.json` | *optional* Main Panel contract override (see §3) |

`.gitignore` already excludes `data/`, databases, keys, backups, logs and `.env*`. **Never commit `data/`.**

## 2. First-time setup (wizard at `/setup`)

1. Log in to your Main Panel (`https://mkweb-panel.onrender.com`) and generate a one-time Child Panel **setup code**.
2. Open your Child Panel URL → it redirects to `/setup`. Enter Main Panel URL (pre-filled), setup code, this panel's public https URL and an admin password (≥10 chars).
3. The panel redeems the code, stores `panelId` + `secret` (encrypted), and makes the returned `ownerEmail` the admin login. The code is single-use; a failed password/URL check never burns it.
4. Log in at `/admin`.

Every authenticated Main Panel request carries the panel's own `panelId`, timestamp, nonce and an HMAC-SHA256 signature made with that panel's own secret. Handled responses: `401` (auth/replay → state `AUTH_ERROR`), `403` (suspended/revoked → purchases/deposits blocked), `409` (payment not configured), `503` (amount slots exhausted), `429` (rate limited, `Retry-After` honoured). Secret rotation: *Minecraft server → Rotate panel secret*.
A heartbeat is sent every 2 minutes; server info (`PUT server-info`) is pushed on setup and on every store-setting change.

## 3. Main Panel contract (`data/contract.json`)

Everything the panel assumes about the Main Panel lives in `lib/mainpanel.js → DEFAULT_CONTRACT` and can be overridden without touching code:

```json
{
  "confirmed": true,
  "timestampUnit": "seconds",
  "signatureEncoding": "hex",
  "headers": { "panelId": "X-Panel-Id", "timestamp": "X-Panel-Timestamp", "nonce": "X-Panel-Nonce", "signature": "X-Panel-Signature" },
  "canonical": "{method}\n{path}\n{timestamp}\n{nonce}\n{bodySha256}",
  "paths": { "redeem": "/api/panel/redeem", "heartbeat": "/api/panel/heartbeat" }
}
```
Canonical variables: `{panelId} {method} {path} {pathname} {query} {timestamp} {nonce} {body} {bodySha256}`. While `"confirmed"` is not `true` the dashboard shows a warning banner. Restart after editing.

## 4. Discord login & deposit log

Admin → **Discord**: Client ID, Client Secret, optional Bot Token + deposit log channel ID. Add the shown redirect URL
(`<public url>/auth/discord/callback`) in the Discord developer portal. OAuth uses `state` (single-use, bound to the browser session); the stable Discord **user ID** is the identity. Secrets are write-only (never returned to the browser). A failed Discord log never affects a wallet credit.

## 5. Minecraft server pairing (exactly one)

Admin → **Minecraft server → Generate pairing code** (15 min, single use). The plugin exchanges it for an API key (`POST /api/plugin/pair`). A second pairing is rejected while one server is active; use **Disconnect / revoke** (password required) and pair again. The API key is stored only as a SHA-256 hash; a revoked key stops working immediately and unconfirmed deliveries return to the queue.

## 6. Plugin-facing API (the plugin itself is not part of this project)

All requests are outbound HTTPS from the plugin (pull model – no inbound ports). Protected routes need
`Authorization: Bearer <apiKey>` (or `X-Api-Key`); optional `X-Server-Id: <serverId>` must match. Errors are `{"error":{"code","message"}}`.
Routes live under `/api/plugin/…`; `/get` and `/confirm` are also exposed at the site root.

> This contract is **proposed** (none was supplied). If your plugin already speaks a different one, tell me and I will adapt the routes.

| Route | Purpose |
|---|---|
| `POST /api/plugin/pair` `{code,name?,version?}` → `{serverId, apiKey, pollIntervalSeconds}` | one-time pairing (5 tries / 15 min / IP) |
| `GET\|POST /get` → `{operations:[…], pollIntervalSeconds:300}` | **Stage 1 – FETCH** |
| `POST /confirm` `{token}` | **Stage 2 – RECEIVED** (send `confirmToken`) and **Stage 3 – SUCCESS** (send `successToken`) |
| `POST /confirm` `{token, status:"FAILED", reason}` | report that execution failed (with the `successToken`) |
| `POST /api/plugin/auth` `{token, username}` | Minecraft login: player ran `/auth <name> <9 digits>` |
| `POST /api/plugin/heartbeat` `{version?}` | optional liveness ping (every `/get` also counts) |

`/get` operation: `{operationId, type:"COMMAND", orderId, player, label, command, confirmToken, successToken, expiresAt}`.
The `command` already has `%player%` replaced by the buyer's verified name.

**Token lifecycle** – `QUEUED → FETCHED → RECEIVED → DELIVERED` (or `FAILED` / `CANCELLED`)

* Fetching never completes anything. Re-fetching a still-`FETCHED` operation returns the **same** tokens (lost-response safe); plugin should de-duplicate by `operationId`.
* `confirmToken` → `RECEIVED` (idempotent). `successToken` is only accepted after `RECEIVED` (`409 received_required` otherwise) → `DELIVERED` (idempotent).
* Tokens are random, bound to one operation + this server; valid 24 h from fetch (refreshed on re-fetch), success token extended to 7 days after `RECEIVED` (offline players). Cancelled/re-queued operations and revoked servers invalidate tokens.
* Errors: `401 invalid_credentials`, `404 invalid_token`, `409 invalid_state|received_required`, `410 token_expired|challenge_expired`, `429 rate_limited`.
* Rate limits (per server, enforced server-side): `/get` 12 per 5 min, `/confirm` 240/min, `/auth` 60/min; 10 failed credentials/min/IP; pairing 5/15 min/IP.

**Minecraft login** – customer enters a username → panel shows `/auth Steve 827491635` (9 random digits, 20 min). Plugin shows "Authenticating with server…", waits ~3 s, calls `/api/plugin/auth`; on timeout it retries the **same** request once. A repeated call after success returns `200 {"ok":true,"idempotent":true}` (never rejects a consumed token). Wrong username `403`, unknown `404`, expired `410`, username already linked to another customer `409`.

## 7. Payments

Deposits use the Main Panel only (`POST /api/panel/payments` → `…/:id/start` → `GET /cheque?value=…`). The exact amount returned (e.g. ₹100.01) is what the customer pays; the wallet is credited with the **requested** amount (₹100.00) exactly once (DB-level uniqueness + conditional update, tested with simultaneous checks). Pending deposits stay in *Transaction history* and can be reopened (QR is drawn in the browser) without creating a new payment. Owner configures UPI at admin → **Payments**.

## 8. Backup & restore

```bash
sqlite3 data/panel.db ".backup 'backups/panel-$(date +%F).db'"   # safe while running
cp data/secret.key backups/                                       # REQUIRED – without it stored secrets cannot be decrypted
```
Restore: stop the app, put `panel.db` and `secret.key` back into `data/`, start.

## 9. Deployment (Render etc.)

* Build `npm install`, start `npm start`. Public URL must be https.
* Zero config: `render.yaml` is included (build `npm install`, start `npm start`, health `/health`). Data defaults to `/tmp/childpanel`, which Render wipes on restart/redeploy (you must run `/setup` again). For permanent data attach a disk and set env `CHILD_PANEL_DATA=/var/data`.
* Behind one proxy the default (`trust proxy hops = 1`) is right; adjust in admin → Payments → *Limits & network*.
* Health check: `GET /health`.

## 10. Tests

`npm test` starts the real server against a mock Main Panel (independent HMAC verifier, replay detection, payments) and mock Discord and runs 178 end-to-end checks (setup, HMAC/replay, admin auth, CRUD, pairing, Minecraft challenge incl. lost-response retry, Discord OAuth, deposits incl. exactly-once credit, purchases, bundles, giveaways, two-token delivery, rate limits, revoke, suspension, IDOR/CSRF, ledger = balances).
In an offline sandbox where Express cannot be installed, `test/shim/` provides a **test-only** Express-compatible shim; with `npm install` done the real Express is used.

## 11. Security notes

scrypt password hashing · server-side sessions in SQLite (HttpOnly, SameSite=Lax, Secure on https, rotated on login) · CSRF token on every state-changing browser request + Origin check · strict CSP (no inline scripts) · all SQL parameterised · all DOM built with `textContent` · https-only image URLs · Main Panel URL SSRF guard · login/pairing/deposit/purchase/plugin rate limits · audit log · integer-paise money · customer-supplied prices/commands never used.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Setup says *Main Panel did not accept the setup code* | code used/expired, or `contract.json` paths don't match your Main Panel |
| Dashboard `AUTH_ERROR` | signature format mismatch (contract) or secret rotated elsewhere |
| Dashboard `SUSPENDED` | Main Panel returned 403; purchases/deposits pause until it clears |
| Discord login "invalid state" | public URL / redirect URL mismatch, or cookies blocked |
| Plugin gets 401 | wrong/revoked key; re-pair |
| Purchases paused | no active server paired |

## Open items (need your input)

1. **Main Panel API document**: redeem endpoint + body, HMAC headers + canonical string + timestamp unit, payment create/start/cheque bodies and responses, heartbeat endpoint, payment-config/status schema, server-info field names, rotate-secret response.
2. **Existing plugin contract** (routes/field names) if one exists.
3. Not built (by design/scope): multi-item cart (single product + quantity checkout instead), image *uploads* (URL-only, validated), automatic refunds (use wallet adjustments).
