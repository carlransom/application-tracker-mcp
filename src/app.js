import express from "express";
import rateLimit from "express-rate-limit";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcpServer.js";

// Builds the Express app. `provider` is the TrackerOAuthProvider (OAuth 2.1
// + PKCE, Google sign-in), `store` is the Firestore data layer, `config` is
// the environment config. The same app runs locally, on Azure Functions
// (custom handler), or on any plain Node host.
export function createApp({ provider, store, config }) {
  const baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  const mcpResourceUrl = `${baseUrl}/mcp`;
  const publicHost = new URL(baseUrl).hostname;

  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: [publicHost, "localhost", "127.0.0.1"],
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  // OAuth 2.1 authorization server: /authorize, /token, /register, /revoke
  // plus /.well-known/oauth-authorization-server and
  // /.well-known/oauth-protected-resource/mcp (discovery metadata).
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(baseUrl),
      scopesSupported: [],
      resourceName: "Application Tracker MCP",
      resourceServerUrl: new URL(mcpResourceUrl),
    }),
  );

  // Completes Google sign-in from the authorize page: verifies the Firebase
  // ID token server-side and returns the redirect back to the MCP client
  // with the authorization code.
  const completeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.post("/oauth/complete", completeLimiter, async (req, res) => {
    try {
      const redirect = await provider.completeAuthorization(req.body || {});
      res.json({ redirect });
    } catch (err) {
      res.status(400).json({
        error: "invalid_request",
        error_description: err.message,
      });
    }
  });

  // MCP endpoint (Streamable HTTP, stateless: a fresh server per request, so
  // it works across Functions instances). A valid Bearer access token is
  // required; the uid is taken from the verified token only — never from
  // anything the client sends.
  const mcpAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    expectedResource: new URL(mcpResourceUrl),
  });
  const handleMcp = async (req, res) => {
    try {
      const uid = req.auth?.extra?.uid;
      if (!uid) {
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      const server = createMcpServer(uid, store);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
  app.post("/mcp", mcpAuth, handleMcp);
  app.get("/mcp", mcpAuth, handleMcp);
  app.delete("/mcp", mcpAuth, handleMcp);

  app.get("/health", (_req, res) =>
    res.json({ ok: true, service: "application-tracker-mcp", version: "1.1.0" }),
  );

  app.get("/", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Application Tracker MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#17251f}code{background:#f0ede4;padding:2px 6px;border-radius:6px}</style>
</head><body>
<h1>Application Tracker MCP server</h1>
<p>MCP access to <a href="https://applicationtracker.app">applicationtracker.app</a>.</p>
<p>Connect it in <b>Claude</b> (Settings &rarr; Connectors &rarr; Add custom connector) or <b>ChatGPT</b> (Developer Mode &rarr; custom MCP server) with this URL:</p>
<p><code>${mcpResourceUrl}</code></p>
<p>Sign in with Google when asked. The assistant can read, add, update, and delete your own applications — and only yours. It can never see or touch another user's data.</p>
<p>Tools: <code>list_applications</code>, <code>get_application</code>, <code>search_applications</code>, <code>get_stats</code>, <code>add_application</code>, <code>update_application</code>, <code>delete_application</code>.</p>
</body></html>`);
  });

  return app;
}
