import { config, REQUIRED_ENV } from "./config.js";
import { TrackerOAuthProvider } from "./authProvider.js";
import { createFirestoreStore, getAdmin } from "./store.js";
import { createApp } from "./app.js";

// Entry point. Runs as a plain Node HTTP server — locally, under Azure
// Functions (custom handler, FUNCTIONS_CUSTOMHANDLER_PORT), or on any host.

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `Missing required environment variables: ${missing.join(", ")}. See .env.example.`,
  );
  process.exit(1);
}
if (
  !config.firebaseWebApiKey ||
  !config.firebaseAuthDomain ||
  !config.firebaseWebAppId
) {
  console.error(
    "Missing Firebase web config (FIREBASE_WEB_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_WEB_APP_ID) — the Google sign-in page cannot load. See .env.example.",
  );
  process.exit(1);
}

const provider = new TrackerOAuthProvider({
  jwtSecret: config.oauthJwtSecret,
  baseUrl: config.publicBaseUrl,
  mcpUrl: `${config.publicBaseUrl}/mcp`,
  verifyIdToken: async (idToken) => {
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    return { uid: decoded.uid };
  },
  firebaseWeb: {
    apiKey: config.firebaseWebApiKey,
    authDomain: config.firebaseAuthDomain,
    projectId: config.firebaseProjectId,
    appId: config.firebaseWebAppId,
  },
  accessTokenTtlSeconds: config.accessTokenTtlSeconds,
  refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
  authCodeTtlSeconds: config.authCodeTtlSeconds,
});

const store = createFirestoreStore();
const app = createApp({ provider, store, config });

app.listen(config.port, "0.0.0.0", () => {
  console.log(`application-tracker-mcp listening on port ${config.port}`);
  console.log(`MCP endpoint: ${config.publicBaseUrl}/mcp`);
});
