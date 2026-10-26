import { BlockList } from "node:net";
import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { IdentityRole } from "@opensiel/shared";
import { constantTimeEqualHex, randomToken, sha256 } from "./crypto.js";
import { unauthorized } from "./errors.js";
import type { Db } from "./db/client.js";
import { identities, identityScopes, orgMembers, orgs, sessions, users } from "./db/schema.js";
import type { Actor, Deps, UserActor } from "./types.js";

export const SESSION_COOKIE = "opensiel_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MACHINE_TOKEN_TTL_SECONDS = 15 * 60;
export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export type MfaChallengePurpose = "login" | "enroll";

export async function hashPassword(password: string): Promise<string> {
  return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken(32);
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure });
}

interface MachineTokenClaims {
  identityId: string;
  name: string;
  role: IdentityRole;
  projectId: string;
  orgId: string;
  envIds: string[];
  tokenVersion: number;
}

export async function signMachineToken(
  env: Deps["env"],
  claims: MachineTokenClaims,
  ttlSeconds = MACHINE_TOKEN_TTL_SECONDS,
): Promise<string> {
  const key = new TextEncoder().encode(env.jwtSecret);
  return new SignJWT({
    typ: "machine",
    name: claims.name,
    role: claims.role,
    projectId: claims.projectId,
    orgId: claims.orgId,
    envIds: claims.envIds,
    tv: claims.tokenVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.identityId)
    .setIssuer("opensiel")
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function signMfaChallenge(
  env: Deps["env"],
  userId: string,
  purpose: MfaChallengePurpose,
): Promise<string> {
  const key = new TextEncoder().encode(env.jwtSecret);
  return new SignJWT({ typ: "mfa", purpose, nonce: randomToken(8) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("opensiel")
    .setIssuedAt()
    .setExpirationTime(`${MFA_CHALLENGE_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyMfaChallenge(
  env: Deps["env"],
  token: string,
  purpose: MfaChallengePurpose,
): Promise<string | null> {
  try {
    const key = new TextEncoder().encode(env.jwtSecret);
    const { payload } = await jwtVerify(token, key, {
      issuer: "opensiel",
      algorithms: ["HS256"],
    });
    if (payload.typ !== "mfa" || payload.purpose !== purpose) return null;
    const userId = String(payload.sub ?? "");
    return userId || null;
  } catch {
    return null;
  }
}

export function ipAllowed(allowlist: string[] | null | undefined, ip: string): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const list = new BlockList();
  try {
    for (const entry of allowlist) {
      const [address, prefixRaw] = entry.split("/");
      const type = address.includes(":") ? "ipv6" : "ipv4";
      if (prefixRaw === undefined) list.addAddress(address, type);
      else list.addSubnet(address, Number(prefixRaw), type);
    }
    return list.check(normalized, normalized.includes(":") ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

function requestToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

export async function resolveActor(deps: Deps, request: FastifyRequest): Promise<Actor | null> {
  const token = requestToken(request);
  if (!token) return null;

  if (token.split(".").length === 3) {
    try {
      const key = new TextEncoder().encode(deps.env.jwtSecret);
      const { payload } = await jwtVerify(token, key, {
        issuer: "opensiel",
        algorithms: ["HS256"],
      });
      if (payload.typ !== "machine") return null;
      const identityId = String(payload.sub);
      const rows = await deps.db
        .select()
        .from(identities)
        .where(eq(identities.id, identityId))
        .limit(1);
      const identity = rows[0];
      if (!identity || identity.revokedAt) return null;
      if (Number(payload.tv) !== identity.tokenVersion) return null;

      const scopes = await deps.db
        .select({ environmentId: identityScopes.environmentId })
        .from(identityScopes)
        .where(eq(identityScopes.identityId, identity.id));

      return {
        type: "machine",
        id: identity.id,
        name: identity.name,
        role: identity.role,
        projectId: identity.projectId,
        orgId: String(payload.orgId),
        envIds: scopes.map((scope) => scope.environmentId),
      };
    } catch {
      return null;
    }
  }

  const rows = await deps.db
    .select({ user: users, member: orgMembers, org: orgs })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    type: "user",
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.member.role,
    orgId: row.org.id,
    orgName: row.org.name,
  };
}

export async function requireActor(deps: Deps, request: FastifyRequest): Promise<Actor> {
  const actor = await resolveActor(deps, request);
  if (!actor) throw unauthorized();
  return actor;
}

export function requireUser(actor: Actor): UserActor {
  if (actor.type !== "user") throw unauthorized("a user session is required");
  return actor;
}

export async function loadUserAuthContext(deps: Deps, userId: string) {
  const rows = await deps.db
    .select({ user: users, member: orgMembers, org: orgs })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) throw unauthorized("account not found");
  return row;
}

export function verifyMachineSecret(expectedHash: string, providedSecret: string): boolean {
  return constantTimeEqualHex(expectedHash, sha256(providedSecret));
}
