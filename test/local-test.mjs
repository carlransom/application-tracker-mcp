import assert from "node:assert";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TrackerOAuthProvider } from "../src/authProvider.js";
import { createMemoryStore } from "../src/store.js";
import { createApp } from "../src/app.js";

// Local verification harness. No real Firebase, no network services: the
// Firestore layer is an in-memory store seeded with two users, and the
// Google sign-in step is stubbed (test ID tokens map to test uids).
// Run: npm test
//
// Verifies:
//  - OAuth discovery metadata endpoints
//  - Unauthenticated /mcp -> 401
//  - Full OAuth 2.1 + PKCE flow (register -> authorize -> complete -> token)
//  - PKCE mismatch and authorization-code reuse are rejected
//  - MCP initialize + tools/list returns exactly the 7 tools (4 read + 3 write)
//  - list/get/search/stats return the calling user's data only
//  - A token for user A cannot read user B's applications (get by id)
//  - Write cycle add -> get -> update -> delete, with validation failures
//    (bad status, missing required fields, unknown fields) rejected
//  - Cross-user write isolation both ways: a token for user A cannot update
//    or delete user B's applications (not found, data untouched), and
//    vice versa
//  - Refresh-token grant issues a working access token
//  - A refresh token or tampered token is rejected as a Bearer token

const UID_A = "test-user-a";
const UID_B = "test-user-b";

const SEED = {
  [UID_A]: [
    { id: "a1", company: "Acme Logistics", role: "Operations Supervisor", location: "Tampa, FL", type: "Full-time", status: "applied", applied: "2026-11-10", closing: "", pay: "$65,000", req: "R1", url: "https://example.com/a1", notes: "Applied via site" },
    { id: "a2", company: "Northwind Traders", role: "Dispatcher", location: "Lakeland, FL", type: "Full-time", status: "interview", applied: "2026-11-12", closing: "2026-11-30", pay: "$24/hr", req: "", url: "", notes: "" },
    { id: "a3", company: "Brightpath Health", role: "Support Specialist", location: "Remote", type: "Full-time", status: "rejected", applied: "2026-11-08", closing: "", pay: "", req: "", url: "", notes: "Rejected Nov 16" },
  ],
  [UID_B]: [
    { id: "b1", company: "Globex Corp", role: "Warehouse Lead", location: "Orlando, FL", type: "Full-time", status: "saved", applied: "", closing: "2026-12-01", pay: "", req: "", url: "", notes: "" },
    { id: "b2", company: "Initech", role: "Logistics Coordinator", location: "Tampa, FL", type: "Full-time", status: "offer", applied: "2026-11-15", closing: "", pay: "$70,000", req: "", url: "", notes: "Offer received" },
  ],
};

const RESULTS = [];
function check(name, ok, detail = "") {
  RESULTS.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return { verifier, challenge };
}

async function postForm(url, params) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

async function mcpClient(base, accessToken) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "local-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// True when a tool call is rejected: either the server answers with a
// JSON-RPC error (thrown by the client SDK, e.g. zod input validation) or
// a tool result flagged isError.
async function expectToolError(client, name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    return res.isError === true;
  } catch {
    return true;
  }
}

// Runs the authorize -> complete -> token flow for one test user and returns
// { accessToken, refreshToken, clientId }.
async function oauthFlow(base, clientId, redirectUri, idToken) {
  const { verifier, challenge } = pkce();
  const state = `state-${randomBytes(4).toString("hex")}`;
  const authUrl =
    `${base}/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&state=${state}`;
  const authRes = await fetch(authUrl);
  assert.equal(authRes.status, 200, "authorize should render the sign-in page");
  const html = await authRes.text();
  assert.ok(html.includes("Sign in with Google"), "authorize page has Google button");

  const completeRes = await fetch(`${base}/oauth/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idToken,
      clientId,
      redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      state,
      scopes: [],
    }),
  });
  assert.equal(completeRes.status, 200, "oauth/complete should succeed");
  const { redirect } = await completeRes.json();
  const code = new URL(redirect).searchParams.get("code");
  assert.ok(code, "redirect carries an authorization code");
  assert.equal(new URL(redirect).searchParams.get("state"), state);

  const tokenRes = await postForm(`${base}/token`, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  assert.equal(tokenRes.status, 200, "token exchange should succeed");
  const tokens = await tokenRes.json();
  assert.ok(tokens.access_token, "access token issued");
  assert.ok(tokens.refresh_token, "refresh token issued");
  assert.equal(tokens.token_type, "Bearer");
  return { ...tokens, clientId, redirectUri, code, verifier };
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const jwtSecret = randomBytes(32).toString("hex");

  const provider = new TrackerOAuthProvider({
    jwtSecret,
    baseUrl: base,
    mcpUrl: `${base}/mcp`,
    verifyIdToken: async (idToken) => {
      if (idToken === "id-token-a") return { uid: UID_A };
      if (idToken === "id-token-b") return { uid: UID_B };
      throw new Error("Invalid ID token");
    },
    firebaseWeb: {
      apiKey: "test-api-key",
      authDomain: "test.firebaseapp.com",
      projectId: "application-tracker-49f9e",
      appId: "test-app-id",
    },
  });
  const store = createMemoryStore(SEED);
  const app = createApp({
    provider,
    store,
    config: {
      publicBaseUrl: base,
      firebaseProjectId: "application-tracker-49f9e",
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });

  try {
    // --- Discovery metadata ---
    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    const prmJson = await prm.json();
    check("protected-resource metadata returns 200", prm.status === 200);
    check(
      "protected-resource metadata names this server as authorization server",
      Array.isArray(prmJson.authorization_servers) &&
        prmJson.authorization_servers.some((u) => String(u).startsWith(base)),
      JSON.stringify(prmJson.authorization_servers),
    );

    const asm = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const asmJson = await asm.json();
    check("authorization-server metadata returns 200", asm.status === 200);
    check(
      "metadata advertises S256 PKCE",
      (asmJson.code_challenge_methods_supported || []).includes("S256"),
    );
    check(
      "metadata advertises authorization_code + refresh_token grants",
      (asmJson.grant_types_supported || []).includes("authorization_code") &&
        (asmJson.grant_types_supported || []).includes("refresh_token"),
    );
    check(
      "metadata has authorize + token endpoints",
      typeof asmJson.authorization_endpoint === "string" &&
        typeof asmJson.token_endpoint === "string",
    );

    // --- Unauthenticated access is rejected ---
    const noAuth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    check("POST /mcp without a token returns 401", noAuth.status === 401);
    check(
      "401 carries a WWW-Authenticate header pointing at resource metadata",
      (noAuth.headers.get("www-authenticate") || "").includes(
        "oauth-protected-resource",
      ),
    );
    const noAuthGet = await fetch(`${base}/mcp`);
    check("GET /mcp without a token returns 401", noAuthGet.status === 401);

    // --- Dynamic client registration ---
    const redirectUri = "http://127.0.0.1:4311/callback";
    const regRes = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: "local-test",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    check("dynamic client registration returns 201", regRes.status === 201);
    const reg = await regRes.json();
    check(
      "registered client_id is a signed JWT",
      typeof reg.client_id === "string" && reg.client_id.split(".").length === 3,
    );
    const clientId = reg.client_id;

    // --- Full OAuth flow for user A ---
    const flowA = await oauthFlow(base, clientId, redirectUri, "id-token-a");
    check("user A completes the OAuth flow and gets tokens", !!flowA.access_token);

    // --- Authorization code reuse is rejected ---
    const reuseRes = await postForm(`${base}/token`, {
      grant_type: "authorization_code",
      code: flowA.code,
      code_verifier: flowA.verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    });
    check(
      "replaying an authorization code is rejected",
      reuseRes.status === 400,
      `status ${reuseRes.status}`,
    );

    // --- Wrong PKCE verifier is rejected ---
    const { verifier: v2, challenge: c2 } = pkce();
    const authUrl2 =
      `${base}/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_challenge=${c2}&code_challenge_method=S256&state=s2`;
    assert.equal((await fetch(authUrl2)).status, 200);
    const comp2 = await fetch(`${base}/oauth/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken: "id-token-a",
        clientId,
        redirectUri,
        codeChallenge: c2,
        codeChallengeMethod: "S256",
        state: "s2",
        scopes: [],
      }),
    });
    const code2 = new URL((await comp2.json()).redirect).searchParams.get("code");
    const wrongVerifier = await postForm(`${base}/token`, {
      grant_type: "authorization_code",
      code: code2,
      code_verifier: "definitely-not-the-verifier",
      redirect_uri: redirectUri,
      client_id: clientId,
    });
    check(
      "wrong PKCE verifier is rejected",
      wrongVerifier.status === 400,
      `status ${wrongVerifier.status}`,
    );
    void v2;

    // --- MCP over the real client SDK, user A ---
    const clientA = await mcpClient(base, flowA.access_token);
    const tools = await clientA.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    check(
      "tools/list returns exactly the 7 tools (4 read + 3 write)",
      JSON.stringify(names) ===
        JSON.stringify([
          "add_application",
          "delete_application",
          "get_application",
          "get_stats",
          "list_applications",
          "search_applications",
          "update_application",
        ]),
      names.join(", "),
    );
    check(
      "write tools are annotated non-read-only, delete is destructive",
      (() => {
        const byName = Object.fromEntries(
          tools.tools.map((t) => [t.name, t.annotations || {}]),
        );
        return (
          byName.add_application?.readOnlyHint === false &&
          byName.update_application?.readOnlyHint === false &&
          byName.delete_application?.readOnlyHint === false &&
          byName.delete_application?.destructiveHint === true &&
          byName.add_application?.destructiveHint === false &&
          byName.list_applications?.readOnlyHint === true
        );
      })(),
    );

    const list = await clientA.callTool({
      name: "list_applications",
      arguments: {},
    });
    const listData = list.structuredContent;
    check(
      "list_applications returns user A's 3 applications only",
      listData.count === 3 &&
        listData.applications.every((a) =>
          ["Acme Logistics", "Northwind Traders", "Brightpath Health"].includes(
            a.company,
          ),
        ),
      `count=${listData.count}`,
    );
    check(
      "applications carry the tracker's real fields",
      ["id", "company", "role", "location", "type", "status", "applied", "closing", "pay", "req", "url", "notes"].every(
        (f) => f in listData.applications[0],
      ),
    );

    const filtered = await clientA.callTool({
      name: "list_applications",
      arguments: { status: "interview" },
    });
    check(
      "status filter works (interview -> 1)",
      filtered.structuredContent.count === 1 &&
        filtered.structuredContent.applications[0].company === "Northwind Traders",
    );

    const one = await clientA.callTool({
      name: "get_application",
      arguments: { id: "a2" },
    });
    check(
      "get_application returns the right application",
      one.structuredContent.application?.company === "Northwind Traders",
    );

    const cross = await clientA.callTool({
      name: "get_application",
      arguments: { id: "b1" },
    });
    check(
      "user A's token CANNOT fetch user B's application (not found)",
      cross.isError === true,
    );

    const search = await clientA.callTool({
      name: "search_applications",
      arguments: { query: "acme" },
    });
    check(
      "search_applications finds Acme",
      search.structuredContent.count === 1 &&
        search.structuredContent.applications[0].company === "Acme Logistics",
    );
    const searchNone = await clientA.callTool({
      name: "search_applications",
      arguments: { query: "zzz-no-such-company" },
    });
    check(
      "search with no match returns 0",
      searchNone.structuredContent.count === 0,
    );

    const stats = await clientA.callTool({ name: "get_stats", arguments: {} });
    check(
      "get_stats counts user A correctly (total 3, interview 1, rejected 1)",
      stats.structuredContent.total === 3 &&
        stats.structuredContent.byStatus.interview === 1 &&
        stats.structuredContent.byStatus.rejected === 1 &&
        stats.structuredContent.byStatus.applied === 1,
      JSON.stringify(stats.structuredContent),
    );
    await clientA.close();

    // --- Refresh-token grant ---
    const refreshRes = await postForm(`${base}/token`, {
      grant_type: "refresh_token",
      refresh_token: flowA.refresh_token,
      client_id: clientId,
    });
    check("refresh-token grant returns 200", refreshRes.status === 200);
    const refreshed = await refreshRes.json();
    const clientA2 = await mcpClient(base, refreshed.access_token);
    const list2 = await clientA2.callTool({
      name: "list_applications",
      arguments: {},
    });
    check(
      "refreshed access token works",
      list2.structuredContent.count === 3,
    );
    await clientA2.close();

    // --- Wrong token types are rejected ---
    const refreshAsBearer = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${flowA.refresh_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    check(
      "a refresh token used as a Bearer token returns 401",
      refreshAsBearer.status === 401,
    );

    const tampered =
      flowA.access_token.slice(0, -2) +
      (flowA.access_token.endsWith("A") ? "BB" : "AA");
    const tamperedRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tampered}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    check("a tampered access token returns 401", tamperedRes.status === 401);

    // --- Second user sees only their own data ---
    const flowB = await oauthFlow(base, clientId, redirectUri, "id-token-b");
    const clientB = await mcpClient(base, flowB.access_token);
    const listB = await clientB.callTool({
      name: "list_applications",
      arguments: {},
    });
    check(
      "user B sees only their own 2 applications",
      listB.structuredContent.count === 2 &&
        listB.structuredContent.applications.every((a) =>
          ["Globex Corp", "Initech"].includes(a.company),
        ),
      `count=${listB.structuredContent.count}`,
    );
    const statsB = await clientB.callTool({
      name: "get_stats",
      arguments: {},
    });
    check(
      "user B stats are separate (total 2, offer 1)",
      statsB.structuredContent.total === 2 &&
        statsB.structuredContent.byStatus.offer === 1,
    );
    const crossB = await clientB.callTool({
      name: "get_application",
      arguments: { id: "a1" },
    });
    check(
      "user B's token CANNOT fetch user A's application (not found)",
      crossB.isError === true,
    );
    await clientB.close();

    // --- Write tools: add -> get -> update -> delete, user A ---
    const clientW = await mcpClient(base, flowA.access_token);

    const addedMin = await clientW.callTool({
      name: "add_application",
      arguments: { company: "Wayne Enterprises", role: "Fleet Supervisor" },
    });
    const minApp = addedMin.structuredContent.application;
    check(
      "add_application with only company+role returns the created app with defaults",
      !!minApp?.id &&
        minApp.company === "Wayne Enterprises" &&
        minApp.role === "Fleet Supervisor" &&
        minApp.status === "saved" &&
        minApp.location === "" &&
        minApp.notes === "",
      JSON.stringify(minApp),
    );

    const addedFull = await clientW.callTool({
      name: "add_application",
      arguments: {
        company: "Stark Industries",
        role: "Dispatcher",
        location: "Tampa, FL",
        type: "Full-time",
        status: "applied",
        applied: "2026-11-18",
        closing: "2026-12-01",
        pay: "$25/hr",
        req: "R9",
        url: "https://example.com/stark",
        notes: "Referred by a friend",
      },
    });
    const fullApp = addedFull.structuredContent.application;
    check(
      "add_application with all fields stores them all",
      fullApp?.company === "Stark Industries" &&
        fullApp.status === "applied" &&
        fullApp.pay === "$25/hr" &&
        fullApp.req === "R9" &&
        fullApp.url === "https://example.com/stark" &&
        fullApp.notes === "Referred by a friend",
    );

    const afterAdd = await clientW.callTool({
      name: "list_applications",
      arguments: {},
    });
    check(
      "list grows after adds (3 seeded + 2 new = 5)",
      afterAdd.structuredContent.count === 5,
      `count=${afterAdd.structuredContent.count}`,
    );

    const updated = await clientW.callTool({
      name: "update_application",
      arguments: { id: fullApp.id, pay: "$27/hr", status: "interview" },
    });
    const updApp = updated.structuredContent.application;
    check(
      "update_application changes only the provided fields",
      updApp?.pay === "$27/hr" &&
        updApp?.status === "interview" &&
        updApp?.company === "Stark Industries" &&
        updApp?.location === "Tampa, FL" &&
        updApp?.notes === "Referred by a friend",
      JSON.stringify(updApp),
    );

    const getUpdated = await clientW.callTool({
      name: "get_application",
      arguments: { id: fullApp.id },
    });
    check(
      "get_application returns the updated application",
      getUpdated.structuredContent.application?.pay === "$27/hr" &&
        getUpdated.structuredContent.application?.status === "interview",
    );

    // --- Write input validation ---
    check(
      "add_application with a bad status is rejected",
      await expectToolError(clientW, "add_application", {
        company: "Bad Co",
        role: "Role",
        status: "hired",
      }),
    );
    check(
      "add_application without role is rejected",
      await expectToolError(clientW, "add_application", {
        company: "No Role Co",
      }),
    );
    check(
      "add_application without company is rejected",
      await expectToolError(clientW, "add_application", {
        role: "No Company Role",
      }),
    );
    check(
      "add_application with an unknown field is rejected",
      await expectToolError(clientW, "add_application", {
        company: "Sneaky Co",
        role: "Role",
        uid: "test-user-b",
      }),
    );
    check(
      "add_application with a client-supplied id is rejected",
      await expectToolError(clientW, "add_application", {
        id: "forged-id",
        company: "Sneaky Co",
        role: "Role",
      }),
    );
    check(
      "update_application with a bad status is rejected",
      await expectToolError(clientW, "update_application", {
        id: fullApp.id,
        status: "hired",
      }),
    );
    check(
      "update_application with an unknown field is rejected",
      await expectToolError(clientW, "update_application", {
        id: fullApp.id,
        salary: "$999",
      }),
    );

    const noFields = await clientW.callTool({
      name: "update_application",
      arguments: { id: fullApp.id },
    });
    check(
      "update_application with no fields to change is an error",
      noFields.isError === true,
    );

    const updateMissing = await clientW.callTool({
      name: "update_application",
      arguments: { id: "does-not-exist", pay: "$1" },
    });
    check(
      "update_application on a nonexistent id is an error, not a create",
      updateMissing.isError === true,
    );
    const afterFailedUpdate = await clientW.callTool({
      name: "list_applications",
      arguments: {},
    });
    check(
      "failed update did not create anything (still 5)",
      afterFailedUpdate.structuredContent.count === 5,
      `count=${afterFailedUpdate.structuredContent.count}`,
    );

    // --- Cross-user write isolation, both directions ---
    const crossUpdate = await clientW.callTool({
      name: "update_application",
      arguments: { id: "b1", pay: "$0/hr" },
    });
    check(
      "user A CANNOT update user B's application (not found)",
      crossUpdate.isError === true,
    );
    const crossDelete = await clientW.callTool({
      name: "delete_application",
      arguments: { id: "b2" },
    });
    check(
      "user A CANNOT delete user B's application (not found)",
      crossDelete.isError === true,
    );

    const clientB2 = await mcpClient(base, flowB.access_token);
    const b1After = await clientB2.callTool({
      name: "get_application",
      arguments: { id: "b1" },
    });
    const b2After = await clientB2.callTool({
      name: "get_application",
      arguments: { id: "b2" },
    });
    check(
      "user B's applications are untouched by user A's attempts",
      b1After.structuredContent.application?.company === "Globex Corp" &&
        b2After.structuredContent.application?.company === "Initech" &&
        b2After.structuredContent.application?.status === "offer",
    );
    const crossUpdateB = await clientB2.callTool({
      name: "update_application",
      arguments: { id: fullApp.id, pay: "$0/hr" },
    });
    check(
      "user B CANNOT update user A's application (not found)",
      crossUpdateB.isError === true,
    );
    const crossDeleteB = await clientB2.callTool({
      name: "delete_application",
      arguments: { id: "a1" },
    });
    check(
      "user B CANNOT delete user A's application (not found)",
      crossDeleteB.isError === true,
    );
    const a1After = await clientW.callTool({
      name: "get_application",
      arguments: { id: "a1" },
    });
    check(
      "user A's application is untouched by user B's attempts",
      a1After.structuredContent.application?.company === "Acme Logistics",
    );
    await clientB2.close();

    // --- Delete cycle closes out the adds ---
    const deletedMin = await clientW.callTool({
      name: "delete_application",
      arguments: { id: minApp.id },
    });
    check(
      "delete_application removes the application",
      deletedMin.structuredContent.deleted === true &&
        deletedMin.structuredContent.id === minApp.id,
    );
    const getDeleted = await clientW.callTool({
      name: "get_application",
      arguments: { id: minApp.id },
    });
    check("get after delete is an error", getDeleted.isError === true);
    const deletedFull = await clientW.callTool({
      name: "delete_application",
      arguments: { id: fullApp.id },
    });
    check(
      "delete_application removes the second added application",
      deletedFull.structuredContent.deleted === true,
    );
    const deleteMissing = await clientW.callTool({
      name: "delete_application",
      arguments: { id: "does-not-exist" },
    });
    check(
      "delete_application on a nonexistent id is an error",
      deleteMissing.isError === true,
    );
    const afterDelete = await clientW.callTool({
      name: "list_applications",
      arguments: {},
    });
    check(
      "list is back to the 3 seeded applications after the full cycle",
      afterDelete.structuredContent.count === 3,
      `count=${afterDelete.structuredContent.count}`,
    );
    await clientW.close();

    // --- Bad ID token is rejected at /oauth/complete ---
    const badComplete = await fetch(`${base}/oauth/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken: "not-a-real-token",
        clientId,
        redirectUri,
        codeChallenge: "abc",
        codeChallengeMethod: "S256",
        state: "s",
        scopes: [],
      }),
    });
    check(
      "an invalid Firebase ID token is rejected at /oauth/complete",
      badComplete.status === 400,
      `status ${badComplete.status}`,
    );
  } finally {
    server.close();
  }

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(
    `\n${RESULTS.length - failed.length}/${RESULTS.length} checks passed.`,
  );
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("TEST HARNESS ERROR:", err);
  process.exit(1);
});
