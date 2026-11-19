import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  signJwt,
  verifyJwt,
  pkceChallengeS256,
  newJti,
} from "./tokens.js";
import { authorizePageHtml } from "./authorizePage.js";

// OAuth 2.1 authorization-code flow with PKCE, per the MCP spec for remote
// servers. Implemented on the MCP TypeScript SDK's OAuthServerProvider
// interface, so the SDK's mcpAuthRouter provides /authorize, /token,
// /register, /revoke and the discovery metadata endpoints.
//
// STATELESS BY DESIGN: client registrations, authorization codes, access
// tokens and refresh tokens are all signed JWTs (HS256, OAUTH_JWT_SECRET).
// The server keeps no per-client state, so it works across Azure Functions
// instances with no shared storage. The one exception is a small in-memory
// set of used authorization-code ids, which is defense-in-depth for
// single-use codes (a replayed code is still only valid for 5 minutes).
//
// Access tokens carry the user's Firebase uid in `sub`. Every Firestore
// read is scoped to users/{uid}/applications for that uid, and the uid is
// never taken from anything the client sends.

function normalizeResource(value) {
  if (!value) return undefined;
  return String(value).replace(/\/+$/, "");
}

/** Dynamic client registration backed by signed JWTs: the client_id IS a JWT. */
export class JwtClientsStore {
  constructor(secret) {
    this.secret = secret;
  }

  async getClient(clientId) {
    try {
      const p = await verifyJwt(this.secret, clientId, "client");
      return {
        client_id: clientId,
        client_id_issued_at: p.iat,
        redirect_uris: p.redirect_uris,
        grant_types: p.grant_types || ["authorization_code", "refresh_token"],
        response_types: p.response_types || ["code"],
        scope: p.scope,
        client_name: p.client_name,
        token_endpoint_auth_method: "none",
      };
    } catch {
      return undefined;
    }
  }

  async registerClient(client) {
    const id = await signJwt(
      this.secret,
      {
        typ: "client",
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        scope: client.scope,
        client_name: client.client_name,
      },
      365 * 24 * 60 * 60, // 1 year
    );
    return {
      ...client,
      client_id: id,
      client_secret: undefined,
      client_secret_expires_at: undefined,
    };
  }
}

export class TrackerOAuthProvider {
  constructor({
    jwtSecret,
    baseUrl,
    mcpUrl,
    verifyIdToken,
    firebaseWeb,
    accessTokenTtlSeconds = 3600,
    refreshTokenTtlSeconds = 30 * 24 * 3600,
    authCodeTtlSeconds = 300,
  }) {
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error("OAUTH_JWT_SECRET must be set and at least 32 characters");
    }
    if (typeof verifyIdToken !== "function") {
      throw new Error("verifyIdToken is required");
    }
    this.jwtSecret = jwtSecret;
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.mcpUrl = String(mcpUrl).replace(/\/+$/, "");
    this.verifyIdToken = verifyIdToken;
    this.firebaseWeb = firebaseWeb;
    this.accessTokenTtlSeconds = accessTokenTtlSeconds;
    this.refreshTokenTtlSeconds = refreshTokenTtlSeconds;
    this.authCodeTtlSeconds = authCodeTtlSeconds;
    this.clientsStore = new JwtClientsStore(jwtSecret);
    this.usedCodes = new Map(); // jti -> expiry ms
  }

  assertResource(resource) {
    if (!resource) return undefined;
    const got = normalizeResource(resource);
    if (got !== normalizeResource(this.mcpUrl)) {
      throw new InvalidRequestError(`Invalid resource: ${resource}`);
    }
    return got;
  }

  // Called by the SDK authorize handler (client_id and redirect_uri already
  // validated). Renders the Google sign-in page; the page finishes the flow
  // through POST /oauth/complete.
  async authorize(client, params, res) {
    this.assertResource(params.resource);
    const html = authorizePageHtml({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      state: params.state || "",
      scopes: params.scopes || [],
      firebaseWeb: this.firebaseWeb,
    });
    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .setHeader("Cache-Control", "no-store")
      .send(html);
  }

  // Called by POST /oauth/complete after the user signs in with Google.
  // Verifies the Firebase ID token, then returns the redirect back to the
  // MCP client with the authorization code.
  async completeAuthorization({
    idToken,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    state,
    scopes,
  }) {
    if (!idToken || !clientId || !redirectUri || !codeChallenge) {
      throw new InvalidRequestError("Missing authorization parameters");
    }
    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      throw new InvalidRequestError("Only S256 PKCE is supported");
    }
    const client = await this.clientsStore.getClient(clientId);
    if (!client) throw new InvalidRequestError("Unknown client");
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }
    const { uid } = await this.verifyIdToken(idToken);
    if (!uid) throw new InvalidRequestError("Could not verify sign-in");
    const code = await signJwt(
      this.jwtSecret,
      {
        typ: "code",
        sub: uid,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: Array.isArray(scopes) ? scopes.join(" ") : "",
        jti: newJti(),
      },
      this.authCodeTtlSeconds,
    );
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return url.toString();
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const payload = await verifyJwt(
      this.jwtSecret,
      authorizationCode,
      "code",
    ).catch(() => {
      throw new InvalidGrantError("Invalid authorization code");
    });
    return payload.code_challenge;
  }

  async exchangeAuthorizationCode(
    client,
    authorizationCode,
    codeVerifier,
    redirectUri,
    resource,
  ) {
    this.assertResource(resource);
    const payload = await verifyJwt(
      this.jwtSecret,
      authorizationCode,
      "code",
    ).catch(() => {
      throw new InvalidGrantError("Invalid authorization code");
    });
    if (payload.client_id !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was not issued to this client",
      );
    }
    if (redirectUri && payload.redirect_uri !== redirectUri) {
      throw new InvalidGrantError(
        "redirect_uri does not match the authorization request",
      );
    }
    // The SDK token handler normally validates PKCE itself and passes no
    // verifier here; if one is passed (skipLocalPkceValidation), check it.
    if (
      codeVerifier &&
      pkceChallengeS256(codeVerifier) !== payload.code_challenge
    ) {
      throw new InvalidGrantError("code_verifier does not match the challenge");
    }
    if (payload.jti) {
      if (this.usedCodes.has(payload.jti)) {
        throw new InvalidGrantError("Authorization code already used");
      }
      this.usedCodes.set(
        payload.jti,
        Date.now() + this.authCodeTtlSeconds * 1000,
      );
      this.pruneUsedCodes();
    }
    return this.issueTokens(
      payload.sub,
      client.client_id,
      payload.scope || "",
      payload.resource,
    );
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    this.assertResource(resource);
    const payload = await verifyJwt(
      this.jwtSecret,
      refreshToken,
      "refresh",
    ).catch(() => {
      throw new InvalidGrantError("Invalid refresh token");
    });
    if (payload.client_id !== client.client_id) {
      throw new InvalidGrantError("Refresh token was not issued to this client");
    }
    const scope =
      scopes && scopes.length ? scopes.join(" ") : payload.scope || "";
    return this.issueTokens(
      payload.sub,
      client.client_id,
      scope,
      payload.resource,
    );
  }

  async issueTokens(uid, clientId, scope, resource) {
    // Always bind the token to this MCP server as its audience, so the
    // bearer-auth check on /mcp passes even for clients that did not send
    // a resource indicator.
    const audience = resource || this.mcpUrl;
    const accessToken = await signJwt(
      this.jwtSecret,
      {
        typ: "access",
        sub: uid,
        client_id: clientId,
        scope,
        resource: audience,
      },
      this.accessTokenTtlSeconds,
    );
    const refreshToken = await signJwt(
      this.jwtSecret,
      {
        typ: "refresh",
        sub: uid,
        client_id: clientId,
        scope,
        resource: audience,
        jti: newJti(),
      },
      this.refreshTokenTtlSeconds,
    );
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope,
    };
  }

  async verifyAccessToken(token) {
    // Must throw InvalidTokenError (not a plain Error) so the SDK's bearer
    // auth middleware answers 401 instead of 500.
    const payload = await verifyJwt(this.jwtSecret, token, "access").catch(
      () => {
        throw new InvalidTokenError("Invalid or expired access token");
      },
    );
    return {
      token,
      clientId: payload.client_id,
      scopes: payload.scope ? payload.scope.split(" ").filter(Boolean) : [],
      expiresAt: payload.exp,
      resource: payload.resource ? new URL(payload.resource) : undefined,
      // The uid comes from the verified token ONLY — never from the client.
      extra: { uid: payload.sub },
    };
  }

  pruneUsedCodes() {
    const now = Date.now();
    for (const [jti, exp] of this.usedCodes) {
      if (exp < now) this.usedCodes.delete(jti);
    }
  }
}
