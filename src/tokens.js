import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

// Stateless signed tokens (HS256, via jose). All OAuth state — client
// registrations, authorization codes, access tokens, refresh tokens — is a
// signed JWT, so the server holds no per-client state and works across
// Azure Functions instances with no shared storage.
//
// Token types ("typ" claim):
//   client  - a registered OAuth client's id (the client_id IS this JWT)
//   code    - a 5-minute authorization code
//   access  - a 1-hour access token; sub = the user's Firebase uid
//   refresh - a 30-day refresh token; sub = the user's Firebase uid

const ALG = "HS256";
const key = (secret) => new TextEncoder().encode(secret);

export async function signJwt(secret, payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key(secret));
}

export async function verifyJwt(secret, token, expectedType) {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: [ALG],
  });
  if (expectedType && payload.typ !== expectedType) {
    throw new Error(`Invalid token type: expected ${expectedType}`);
  }
  return payload;
}

/** PKCE S256 challenge for a verifier (RFC 7636). */
export function pkceChallengeS256(codeVerifier) {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function newJti() {
  return randomUUID();
}
