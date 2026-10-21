import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OidcConfig } from "./env.js";
import { badRequest } from "./errors.js";

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcClaims {
  email: string;
  name: string;
  subject?: string;
}

const discoveryCache = new Map<string, { document: OidcDiscovery; fetchedAt: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export async function getDiscovery(issuer: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.document;

  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw badRequest("could not reach the OIDC provider");
  }
  if (!response.ok) {
    throw badRequest(`OIDC discovery failed (${response.status})`);
  }

  const document = (await response.json()) as Partial<OidcDiscovery>;
  if (
    typeof document.issuer !== "string" ||
    typeof document.authorization_endpoint !== "string" ||
    typeof document.token_endpoint !== "string" ||
    typeof document.jwks_uri !== "string"
  ) {
    throw badRequest("the OIDC provider returned an incomplete discovery document");
  }

  const discovery: OidcDiscovery = {
    issuer: document.issuer,
    authorization_endpoint: document.authorization_endpoint,
    token_endpoint: document.token_endpoint,
    jwks_uri: document.jwks_uri,
  };
  discoveryCache.set(issuer, { document: discovery, fetchedAt: Date.now() });
  return discovery;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function getJwks(discovery: OidcDiscovery): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(discovery.jwks_uri);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  jwksCache.set(discovery.jwks_uri, jwks);
  return jwks;
}

export async function exchangeCode(
  config: OidcConfig,
  discovery: OidcDiscovery,
  code: string,
  verifier: string,
  expectedNonce: string,
): Promise<OidcClaims> {
  let response: Response;
  try {
    response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw badRequest("could not reach the OIDC token endpoint");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw badRequest(
      `token exchange failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) throw badRequest("the provider did not return an id_token");

  let payload;
  try {
    const verified = await jwtVerify(tokens.id_token, getJwks(discovery), {
      issuer: config.issuer,
      audience: config.clientId,
    });
    payload = verified.payload;
  } catch {
    throw badRequest("could not verify the provider id_token");
  }

  if (payload.nonce !== expectedNonce) throw badRequest("nonce mismatch");

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@"))
    throw badRequest("the provider did not return an email address");
  if (payload.email_verified === false) {
    throw badRequest("the provider reports this email as unverified");
  }

  const name =
    typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : email.split("@")[0];

  return {
    email,
    name,
    subject: typeof payload.sub === "string" ? payload.sub : undefined,
  };
}
