# Application Tracker — MCP server

MCP server for [applicationtracker.app](https://applicationtracker.app).
Lets Claude and ChatGPT connect to a user's own Application Tracker and
**read and write** their job applications — list, search, get one, stats,
and add, update, and delete applications.

**Multi-user by design.** Every user signs in with the same Google account
they use in the tracker app (OAuth 2.1 authorization-code flow with PKCE).
The server issues short-lived access tokens bound to that user's Firebase
uid, and every Firestore read and write is scoped to
`users/{uid}/applications` for the uid in the verified token. A user can
only ever see — or change — their own data.

## Tools (7 total: 4 read + 3 write)

| Tool | What it does |
| --- | --- |
| `list_applications` | List the user's applications, newest first. Optional `status` filter (saved, applied, screening, interview, offer, accepted, rejected, withdrawn) and `limit` (default 50, max 100). |
| `get_application` | Get one application by `id`. |
| `search_applications` | Text search over company, role, location, and notes. |
| `get_stats` | Total plus counts by status, active count, offers, interviews. |
| `add_application` | Add an application. Required: `company`, `role`. Optional: `location`, `type`, `status`, `applied`, `closing`, `pay`, `req`, `url`, `notes`. Status defaults to `saved`. Returns the created application with its generated `id`. |
| `update_application` | Update one application by `id`. Only the fields provided change; at least one field besides `id` is required. Updating an application that does not exist is an error, never a create. |
| `delete_application` | Permanently delete one application by `id`. Deleting an application that does not exist is an error. |

Write tools validate all input with zod before it reaches Firestore:
`status` must be one of the known pipeline statuses, and unknown fields
are rejected (including a client-supplied `id` on add, or a `uid` — no
tool accepts a uid parameter, and the uid always comes from the verified
access token). There are no bulk operations.

## How it works

- **Stack:** Node.js 20+, Express, `@modelcontextprotocol/sdk` (Streamable HTTP
  transport, stateless — one fresh server per request), Firebase Admin SDK.
  The live Web App runs Node 22 LTS.
- **OAuth 2.1 + PKCE** using the SDK's `mcpAuthRouter` and a custom
  `OAuthServerProvider` (`src/authProvider.js`):
  - Dynamic client registration (`POST /register`). Client ids are signed
    JWTs, so no client database is needed.
  - `GET /authorize` renders a Google sign-in page (Firebase Auth JS SDK,
    same Google sign-in as the tracker app). After sign-in the page POSTs
    the Firebase ID token to `POST /oauth/complete`, which verifies it
    server-side with the Admin SDK and redirects the browser back to the
    MCP client with the authorization code.
  - `POST /token` exchanges codes (PKCE verified by the SDK handler) and
    refresh tokens. Access tokens live 1 hour, refresh tokens 30 days.
  - Discovery: `/.well-known/oauth-authorization-server` and
    `/.well-known/oauth-protected-resource/mcp`.
- **Stateless tokens:** client registrations, authorization codes, access
  tokens, and refresh tokens are all signed JWTs (HS256, `OAUTH_JWT_SECRET`).
  The server keeps no per-client state, so it works across Azure Functions
  instances with no shared storage. (One exception: a small in-memory set of
  used authorization-code ids, defense-in-depth for single-use codes.)
- **Per-user scoping:** the access token's `sub` is the Firebase uid. The
  MCP handler builds the tool server with that uid, and every Firestore
  read and write goes to `users/{uid}/applications`. The uid is never taken
  from anything the client sends.
- **Write access:** `add_application`, `update_application`, and
  `delete_application` resolve the uid the same way — from the verified
  access token only. Writes are validated with zod strict schemas in
  `src/mcpServer.js` (unknown fields rejected, status must be a known
  pipeline status) and again defensively in `src/store.js`. Update and
  delete first check the document exists under the caller's own
  subcollection, so touching another user's application fails as "not
  found" and never leaks or modifies it. There are no bulk write
  operations and no way to address another user's data.
- **Service account:** server-side only, Firestore read/write access
  (`roles/datastore.user`). See deployment step 2 — the account must be
  upgraded from the original read-only `roles/datastore.viewer`, or all
  writes fail with permission denied.

## Run locally

```bash
npm ci
cp .env.example .env   # fill in the values (placeholders only in the example)
npm test               # local verification harness (no real Firebase needed)
npm start              # serves on http://localhost:3000
```

`npm test` (`test/local-test.mjs`) runs the full flow against an in-memory
store with two test users: OAuth discovery, 401 without a token, dynamic
registration, authorize → complete → token, PKCE mismatch and code-replay
rejection, MCP initialize + tools/list, all seven tools, cross-user
isolation both ways (a token for user A cannot read, update, or delete
user B's applications — and vice versa), the full write cycle
(add → get → update → delete) with validation failures (bad status,
missing required fields, unknown fields, update/delete of a nonexistent
id), refresh-token grant, and tampered-token rejection. It must print
`58/58 checks passed.`

## Deploy to Azure App Service

Target: **Web App `application-tracker-mcp-web`**, App Service plan
`application-tracker-mcp-plan` (F1 Free tier), resource group
`application-tracker-rg`, region West US 2, Node 22 LTS, in the existing
subscription "Azure subscription 1". Endpoint:
`https://application-tracker-mcp-web.azurewebsites.net/mcp`.

The app runs as a plain Node server (`npm start` → `node src/index.js`)
on App Service — no Functions host involved. (An earlier deployment on
Azure Functions Flex Consumption could not run this custom-handler app:
the function never registered and `/health` stayed 404, so the app was
moved to App Service unchanged. The Function App
`application-tracker-mcp` is left standing but unused.)

### 1. Create the Web App (Azure portal or `az` CLI)

- Create an App Service plan named `application-tracker-mcp-plan` in
  resource group `application-tracker-rg`, West US 2, **F1 Free** tier.
  (F1 quota is 0 in East US 2, East US, and Central US — West US 2 is
  where a free instance was available.)
- Create a Linux Web App named `application-tracker-mcp-web` in that
  plan, **Node 22 LTS** (Node 20 LTS is no longer offered as a Linux
  runtime).
- Set `SCM_DO_BUILD_DURING_DEPLOYMENT=true` so dependencies install on
  the server at deploy time.
- Set these **Application settings** (Configuration → Application settings):
  - `PUBLIC_BASE_URL` = `https://application-tracker-mcp-web.azurewebsites.net`
  - `FIREBASE_PROJECT_ID` = `application-tracker-49f9e`
  - `FIREBASE_SERVICE_ACCOUNT_JSON` = the whole service-account JSON (step 2)
  - `OAUTH_JWT_SECRET` = the value in `OAUTH_JWT_SECRET.txt` in this folder
    (mode 600; **never commit it, never paste it into chat or a ticket**)
  - `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`
    (`application-tracker-49f9e.firebaseapp.com`), `FIREBASE_WEB_APP_ID` =
    the tracker's public Firebase web config (same values as in the tracker
    app's source)

### 2. Create a least-privilege Firebase service account

Do **not** use the Firebase console's "Generate new private key" — that key
belongs to the default service account, which has the broad Editor role.

1. In the Google Cloud console (same Google account, project
   `application-tracker-49f9e`), create a service account, e.g.
   `mcp-server-reader`.
2. Grant it **`roles/datastore.user`** (Firestore User) — read **and**
   write access to Firestore, nothing else. **Required for write access:**
   the account was originally granted read-only
   `roles/datastore.viewer`; until the role is upgraded, every write tool
   call fails with permission denied while reads keep working.
3. Create a JSON key for it and paste the entire JSON as the
   `FIREBASE_SERVICE_ACCOUNT_JSON` app setting. The private key inside it
   must never be printed, logged, or committed.

### 3. Let the authorize page sign in with Google

The `GET /authorize` page runs on the Web App domain and uses the
tracker Firebase project's Google sign-in, so two console entries must
allow that domain:

1. **Firebase console → Authentication → Settings → Authorized domains:**
   add `application-tracker-mcp-web.azurewebsites.net`.
2. **Google Cloud console → Credentials → the "Browser key (auto created by
   Firebase)" → HTTP referrers:** add
   `https://application-tracker-mcp-web.azurewebsites.net/*` (the tracker key is
   restricted to the live site + `*.firebaseapp.com`; the new origin must be
   added or Google sign-in on the authorize page will be rejected).

### 4. GitHub repo + deploy

- Public repo **`carlransom/application-tracker-mcp`** holds this folder's
  contents (root of the repo). No secrets are in the repo:
  `.env`, `local.settings.json`, and `OAUTH_JWT_SECRET.txt` are gitignored.
- The repo has a secret named **`AZURE_CREDENTIALS`** — the JSON for the
  Entra app registration `application-tracker-mcp-deploy` (Contributor on
  resource group `application-tracker-rg`), used by `azure/login@v2`.
- Pushing to `main` runs `.github/workflows/deploy.yml` (Node 20, `npm ci`,
  `azure/login@v2`, then `az webapp deployment source config-zip` to
  `application-tracker-mcp-web`). The zip excludes `.git`, `node_modules`,
  and all secret files; dependencies install on the server because
  `SCM_DO_BUILD_DURING_DEPLOYMENT=true` is set.

## Verify live (after deploy)

```bash
BASE=https://application-tracker-mcp-web.azurewebsites.net
curl -s $BASE/health
# -> {"ok":true,"service":"application-tracker-mcp","version":"1.1.0"}

# Unauthenticated MCP request must be 401:
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
# -> 401
```

Then connect in Claude (below) with Carl's Google account and ask for the
application list — it must return Carl's real applications with the correct
fields and statuses. Confirm `tools/list` shows all seven tools. To verify
multi-user isolation, connect a second Google account that has its own
tracker data and confirm it sees only its own applications. To verify
writes, add an application through the assistant, check it appears in
the tracker app, then delete it the same way.

## Connect

**Claude** (web, desktop, mobile — Free plan allows one custom connector):
Settings → Connectors → Add custom connector → paste
`https://application-tracker-mcp-web.azurewebsites.net/mcp` → sign in with Google
when asked. Or in Claude Code:
`claude mcp add --transport http application-tracker https://application-tracker-mcp-web.azurewebsites.net/mcp`

**ChatGPT** (web only, Developer Mode; needs a paid plan — Plus or higher):
Settings → Security and login → turn on Developer mode → Plugins →
create a custom MCP connector → paste the same URL → sign in with Google.
Note: ChatGPT only connects to remote servers over HTTPS, and some plans
limit custom connectors to read/fetch-style tools — the read tools fit
that shape; the write tools may not be available there.

## Security notes and known limitations

- **No server-side token revocation list.** Access tokens expire after 1
  hour; refresh tokens after 30 days and rotate on each use. A stolen
  refresh token stays usable until expiry unless `OAUTH_JWT_SECRET` is
  rotated (rotating it invalidates every token immediately). A Firestore-
  backed revocation list can be added later if needed.
- **Authorization codes are single-use in-memory.** A replayed code is
  rejected if it hits the same instance; the 5-minute expiry bounds the
  residual risk across instances.
- **Write access is scoped, validated, and single-user.** Write tools
  resolve the uid from the verified access token only; update and delete
  check the document exists under that uid first, so a cross-user write
  fails as "not found" and never leaks or modifies the other user's data.
  Input is validated with zod strict schemas (unknown fields rejected,
  status must be a known pipeline status). There are no bulk operations.
  The service account's IAM role must be `roles/datastore.user` for
  writes to work at all — with the old `roles/datastore.viewer` every
  write fails with permission denied.
- **Rate limiting:** the SDK's auth router rate-limits its endpoints, and
  `/oauth/complete` has its own limiter (30 per 15 min per IP).
- **Streaming:** the MCP endpoint uses Streamable HTTP. It runs on Azure
  App Service (Free F1 tier, plain Node), which serves it directly.
- **CORS:** the MCP endpoint is called server-to-server by Claude/ChatGPT
  clouds, so no browser CORS is needed. The authorize page is same-origin.
