# Application Tracker — MCP server

Read-only MCP server for [applicationtracker.app](https://applicationtracker.app).
Lets Claude and ChatGPT connect to a user's own Application Tracker and **read**
their job applications — list, search, get one, and stats. It cannot add,
change, or delete anything.

**Multi-user by design.** Every user signs in with the same Google account
they use in the tracker app (OAuth 2.1 authorization-code flow with PKCE).
The server issues short-lived access tokens bound to that user's Firebase
uid, and every Firestore read is scoped to `users/{uid}/applications` for
the uid in the verified token. A user can only ever see their own data.

## Tools (read-only — there are no write tools)

| Tool | What it does |
| --- | --- |
| `list_applications` | List the user's applications, newest first. Optional `status` filter (saved, applied, screening, interview, offer, accepted, rejected, withdrawn) and `limit` (default 50, max 100). |
| `get_application` | Get one application by `id`. |
| `search_applications` | Text search over company, role, location, and notes. |
| `get_stats` | Total plus counts by status, active count, offers, interviews. |

## How it works

- **Stack:** Node.js 20, Express, `@modelcontextprotocol/sdk` (Streamable HTTP
  transport, stateless — one fresh server per request), Firebase Admin SDK.
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
  read goes to `users/{uid}/applications`. The uid is never taken from
  anything the client sends.
- **Service account:** server-side only, read-only Firestore access
  (`roles/datastore.viewer`). See deployment step 2.

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
rejection, MCP initialize + tools/list, all four tools, cross-user isolation
(a token for user A cannot read user B's applications), refresh-token grant,
and tampered-token rejection. It must print `32/32 checks passed.`

## Deploy to Azure Functions

Target: **Function App `application-tracker-mcp`**, resource group
`application-tracker-rg`, region East US 2, Node 20, Consumption plan, in the
existing subscription "Azure subscription 1". Endpoint:
`https://application-tracker-mcp-cre6f4h5grbdc4hq.eastus2-01.azurewebsites.net/mcp`.

The app is packaged as an **Azure Functions custom handler**: `host.json`
runs `node src/index.js` as a plain Express server and the Functions host
forwards HTTP to it (`functions/mcp/function.json` is the catch-all trigger).
This keeps the MCP server code host-agnostic — the same code runs locally or
on any plain Node host.

### 1. Create the Function App (Azure portal)

- Create a Function App named `application-tracker-mcp` in resource group
  `application-tracker-rg`, East US 2, **Consumption** plan, **Node 20**.
- Do **not** set `FUNCTIONS_WORKER_RUNTIME` — a custom-handler app must not
  have it (the `customHandler` section in `host.json` is what the host uses).
- Set these **Application settings** (Configuration → Application settings):
  - `PUBLIC_BASE_URL` = `https://application-tracker-mcp-cre6f4h5grbdc4hq.eastus2-01.azurewebsites.net`
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
2. Grant it **only** `roles/datastore.viewer` (Firestore Viewer) — read-only
   Firestore access, nothing else.
3. Create a JSON key for it and paste the entire JSON as the
   `FIREBASE_SERVICE_ACCOUNT_JSON` app setting. The private key inside it
   must never be printed, logged, or committed.

### 3. Let the authorize page sign in with Google

The `GET /authorize` page runs on the Function App domain and uses the
tracker Firebase project's Google sign-in, so two console entries must
allow that domain:

1. **Firebase console → Authentication → Settings → Authorized domains:**
   add `application-tracker-mcp-cre6f4h5grbdc4hq.eastus2-01.azurewebsites.net`.
2. **Google Cloud console → Credentials → the "Browser key (auto created by
   Firebase)" → HTTP referrers:** add
   `https://application-tracker-mcp-cre6f4h5grbdc4hq.eastus2-01.azurewebsites.net/*` (the tracker key is
   restricted to the live site + `*.firebaseapp.com`; the new origin must be
   added or Google sign-in on the authorize page will be rejected).

### 4. GitHub repo + deploy

- Create public repo **`carlransom/application-tracker-mcp`** and push this
  folder's contents (root of the repo). No secrets are in the repo:
  `.env`, `local.settings.json`, and `OAUTH_JWT_SECRET.txt` are gitignored.
- In the Function App, download the **publish profile**
  (Overview → Get publish profile) and add it as a repo secret named
  `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`.
- Pushing to `main` runs `.github/workflows/deploy.yml` (Node 20, `npm ci`,
  zip deploy via `Azure/functions-action`). The workflow deploys
  `node_modules` with the package (custom handler needs them at runtime).

## Verify live (after deploy)

```bash
BASE=https://application-tracker-mcp-cre6f4h5grbdc4hq.eastus2-01.azurewebsites.net
curl -s $BASE/health
# -> {"ok":true,"service":"application-tracker-mcp","version":"1.0.0"}

# Unauthenticated MCP request must be 401:
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
# -> 401
```

Then connect in Claude (below) with Carl's Google account and ask for the
application list — it must return Carl's real applications with the correct
fields and statuses. Confirm `tools/list` shows only the four read-only
tools. To verify multi-user isolation, connect a second Google account that
has its own tracker data and confirm it sees only its own applications.

## Connect

**Claude** (web, desktop, mobile — Free plan allows one custom connector):
Settings → Connectors → Add custom connector → paste
`https://application-tracker-mcp-cre6f4h5grbdc4hq.eastus2-01.azurewebsites.net/mcp` → sign in with Google
when asked. Or in Claude Code:
`claude mcp add --transport http application-tracker https://application-tracker-mcp-cre6f4h5grbdc4hq.eastus2-01.azurewebsites.net/mcp`

**ChatGPT** (web only, Developer Mode; needs a paid plan — Plus or higher):
Settings → Security and login → turn on Developer mode → Plugins →
create a custom MCP connector → paste the same URL → sign in with Google.
Note: ChatGPT only connects to remote servers over HTTPS, and some plans
limit custom connectors to read/fetch-style tools — the read-only tools here
fit that shape.

## Security notes and known limitations

- **No server-side token revocation list.** Access tokens expire after 1
  hour; refresh tokens after 30 days and rotate on each use. A stolen
  refresh token stays usable until expiry unless `OAUTH_JWT_SECRET` is
  rotated (rotating it invalidates every token immediately). A Firestore-
  backed revocation list can be added later if needed.
- **Authorization codes are single-use in-memory.** A replayed code is
  rejected if it hits the same instance; the 5-minute expiry bounds the
  residual risk across instances.
- **Read-only by construction.** The server has no write tools and the data
  layer (`src/store.js`) has no write methods. The service account is
  read-only in IAM as well.
- **Rate limiting:** the SDK's auth router rate-limits its endpoints, and
  `/oauth/complete` has its own limiter (30 per 15 min per IP).
- **Streaming:** the MCP endpoint uses Streamable HTTP. If Server-Sent
  Events streaming ever proves unreliable through the Functions custom
  handler, the fallback is to run this same code on Azure App Service
  (Free F1 tier, plain Node) — no code changes needed.
- **CORS:** the MCP endpoint is called server-to-server by Claude/ChatGPT
  clouds, so no browser CORS is needed. The authorize page is same-origin.
