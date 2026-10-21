import { hash, verify } from "@node-rs/argon2";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { IdentityRole } from "@opensiel/shared";
import { constantTimeEqualHex, randomToken, sha256 } from "./crypto.js";
import { unauthorized } from "./errors.js";
import type { Db } from "./db/client.js";
import { orgMembers, orgs, sessions, users } from "./db/schema.js";
import type { Actor, Deps, UserActor } from "./types.js";

export const SESSION_COOKIE = "opensiel_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MACHINE_TOKEN_TTL_SECONDS = 15 * 60;

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
}

export async function signMachineToken(env: Deps["env"], claims: MachineTokenClaims): Promise<string> {
  const key = new TextEncoder().encode(env.jwtSecret);
  return new SignJWT({
    typ: "machine",
    name: claims.name,
    role: claims.role,
    projectId: claims.projectId,
    orgId: claims.orgId,
    envIds: claims.envIds,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.identityId)
    .setIssuer("opensiel")
    .setIssuedAt()
    .setExpirationTime(`${MACHINE_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

function requestToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

export async function resolveActor(deps: Deps, request: FastifyRequest): Promise<Actor | null> {
  const token = requestToken(request);
  if (!token) return null;

  if (token.split(".").length === 3) {
    try {
      const key = new TextEncoder().encode(deps.env.jwtSecret);
      const { payload } = await jwtVerify(token, key, { issuer: "opensiel", algorithms: ["HS256"] });
      if (payload.typ !== "machine") return null;
      return {
        type: "machine",
        id: String(payload.sub),
        name: String(payload.name ?? "machine"),
        role: payload.role as IdentityRole,
        projectId: String(payload.projectId),
        orgId: String(payload.orgId),
        envIds: Array.isArray(payload.envIds) ? (payload.envIds as string[]) : [],
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

export function verifyMachineSecret(expectedHash: string, providedSecret: string): boolean {
  return constantTimeEqualHex(expectedHash, sha256(providedSecret));
}
