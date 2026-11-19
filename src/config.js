// Central configuration. All secrets come from environment variables;
// nothing secret is committed to the repo. See .env.example.
const port = Number(
  process.env.FUNCTIONS_CUSTOMHANDLER_PORT || process.env.PORT || 3000,
);

export const config = {
  port,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(
    /\/+$/,
    "",
  ),
  firebaseProjectId:
    process.env.FIREBASE_PROJECT_ID || "application-tracker-49f9e",
  firebaseServiceAccountJson:
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
  oauthJwtSecret: process.env.OAUTH_JWT_SECRET || "",
  // Public Firebase web config (same values as the tracker app) — used only
  // to load the Google sign-in widget on the authorize page. These are client
  // config values, not secrets, but they are still read from env so the repo
  // carries no credentials at all.
  firebaseWebApiKey: process.env.FIREBASE_WEB_API_KEY || "",
  firebaseAuthDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
  firebaseWebAppId: process.env.FIREBASE_WEB_APP_ID || "",

  accessTokenTtlSeconds: 60 * 60, // 1 hour
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60, // 30 days
  authCodeTtlSeconds: 5 * 60, // 5 minutes
  clientTtlSeconds: 365 * 24 * 60 * 60, // 1 year
};

// Application statuses, exactly as the tracker app stores them.
export const STATUSES = [
  "saved",
  "applied",
  "screening",
  "interview",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
];

export const mcpUrl = () => `${config.publicBaseUrl}/mcp`;

// Required in production. The local test harness supplies its own values.
export const REQUIRED_ENV = [
  "OAUTH_JWT_SECRET",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
];
