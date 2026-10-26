import { and, count, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  mfaDisableSchema,
  mfaLoginSchema,
  mfaSetupSchema,
  mfaVerifySchema,
} from "@opensiel/shared";
import {
  createSession,
  loadUserAuthContext,
  MFA_CHALLENGE_TTL_SECONDS,
  requireActor,
  requireUser,
  setSessionCookie,
  verifyMfaChallenge,
  verifyPassword,
} from "../auth.js";
import { decryptValue, encryptValue, sha256 } from "../crypto.js";
import { badRequest, conflict, forbidden, parse, unauthorized } from "../errors.js";
import { orgs, userMfa, userMfaRecoveryCodes } from "../db/schema.js";
import type { UserMfaRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "../mfa.js";
import type { Deps, UserActor } from "../types.js";

function mfaAad(userId: string): string {
  return `mfa:${userId}`;
}

async function loadMfa(deps: Deps, userId: string): Promise<UserMfaRow | undefined> {
  const rows = await deps.db.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  return rows[0];
}

function decryptSecret(deps: Deps, row: UserMfaRow): string {
  return decryptValue(
    deps.env.masterKey,
    {
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      tag: row.secretTag,
    },
    mfaAad(row.userId),
  );
}

async function unusedRecoveryCodes(deps: Deps, userId: string): Promise<number> {
  const rows = await deps.db
    .select({ total: count() })
    .from(userMfaRecoveryCodes)
    .where(and(eq(userMfaRecoveryCodes.userId, userId), isNull(userMfaRecoveryCodes.usedAt)));
  return Number(rows[0]?.total ?? 0);
}

async function actorFromEnrollmentToken(deps: Deps, token: string): Promise<UserActor> {
  const userId = await verifyMfaChallenge(deps.env, token, "enroll");
  if (!userId) throw unauthorized("invalid or expired enrollment token");
  const context = await loadUserAuthContext(deps, userId);
  return {
    type: "user",
    id: context.user.id,
    name: context.user.name,
    email: context.user.email,
    role: context.member.role,
    orgId: context.org.id,
    orgName: context.org.name,
  };
}

async function resolveEnrollmentActor(
  deps: Deps,
  request: FastifyRequest,
  enrollmentToken?: string,
): Promise<UserActor> {
  if (enrollmentToken) return actorFromEnrollmentToken(deps, enrollmentToken);
  return requireUser(await requireActor(deps, request));
}

function auditMfa(
  deps: Deps,
  actor: UserActor,
  action: string,
  metadata: Record<string, unknown>,
  ip: string,
) {
  return writeAudit(deps, {
    orgId: actor.orgId,
    actorType: "user",
    actorId: actor.id,
    actorName: actor.name,
    action,
    resourceType: "user",
    resourceId: actor.id,
    metadata,
    ip,
  });
}

export function registerMfaRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/auth/mfa", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    const row = await loadMfa(deps, actor.id);
    const orgRows = await deps.db
      .select({ mfaRequired: orgs.mfaRequired })
      .from(orgs)
      .where(eq(orgs.id, actor.orgId))
      .limit(1);

    return {
      enabled: Boolean(row?.enabled),
      recoveryCodesRemaining: row?.enabled ? await unusedRecoveryCodes(deps, actor.id) : 0,
      orgRequired: Boolean(orgRows[0]?.mfaRequired),
    };
  });

  app.post(
    "/api/auth/mfa/setup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const input = parse(mfaSetupSchema, request.body ?? {});
      const actor = await resolveEnrollmentActor(deps, request, input.enrollmentToken);
      const existing = await loadMfa(deps, actor.id);
      if (existing?.enabled) {
        throw conflict("MFA is already enabled; disable it before enrolling again");
      }

      const secret = generateTotpSecret();
      const encrypted = encryptValue(deps.env.masterKey, secret, mfaAad(actor.id));

      if (existing) {
        await deps.db
          .update(userMfa)
          .set({
            secretCiphertext: encrypted.ciphertext,
            secretIv: encrypted.iv,
            secretTag: encrypted.tag,
            enabled: false,
            lastUsedStep: null,
            enabledAt: null,
          })
          .where(eq(userMfa.userId, actor.id));
      } else {
        await deps.db.insert(userMfa).values({
          userId: actor.id,
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretTag: encrypted.tag,
        });
      }

      await auditMfa(deps, actor, "mfa.setup", {}, request.ip);
      return { secret, otpauthUrl: otpauthUrl(secret, actor.email) };
    },
  );

  app.post(
    "/api/auth/mfa/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parse(mfaVerifySchema, request.body ?? {});
      const actor = await resolveEnrollmentActor(deps, request, input.enrollmentToken);
      const row = await loadMfa(deps, actor.id);
      if (!row) throw badRequest("start MFA setup first");
      if (row.enabled) throw conflict("MFA is already enabled");

      const secret = decryptSecret(deps, row);
      const step = verifyTotp(secret, input.code);
      if (step === null) {
        await auditMfa(deps, actor, "mfa.failed", { stage: "enroll" }, request.ip);
        throw unauthorized("invalid code");
      }

      const codes = generateRecoveryCodes(10);
      await deps.db.transaction(async (tx) => {
        await tx.delete(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, actor.id));
        await tx.insert(userMfaRecoveryCodes).values(
          codes.map((code) => ({
            userId: actor.id,
            codeHash: sha256(normalizeRecoveryCode(code)),
          })),
        );
        await tx
          .update(userMfa)
          .set({ enabled: true, enabledAt: new Date() })
          .where(eq(userMfa.userId, actor.id));
      });

      await auditMfa(deps, actor, "mfa.enable", {}, request.ip);

      if (input.enrollmentToken) {
        const token = await createSession(deps.db, actor.id);
        setSessionCookie(reply, token, deps.env.secureCookies);
        return reply.code(201).send({
          enabled: true,
          recoveryCodes: codes,
          token,
          user: {
            id: actor.id,
            email: actor.email,
            name: actor.name,
            role: actor.role,
            orgId: actor.orgId,
            orgName: actor.orgName,
          },
        });
      }

      return reply.code(201).send({ enabled: true, recoveryCodes: codes });
    },
  );

  app.post(
    "/api/auth/mfa/disable",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = requireUser(await requireActor(deps, request));
      const input = parse(mfaDisableSchema, request.body);
      const row = await loadMfa(deps, actor.id);
      if (!row?.enabled) throw badRequest("MFA is not enabled");

      const context = await loadUserAuthContext(deps, actor.id);
      const validPassword = await verifyPassword(context.user.passwordHash, input.password);
      if (!validPassword) throw unauthorized("invalid password");

      const orgRows = await deps.db
        .select({ mfaRequired: orgs.mfaRequired })
        .from(orgs)
        .where(eq(orgs.id, actor.orgId))
        .limit(1);
      if (orgRows[0]?.mfaRequired) {
        throw forbidden("your organization requires MFA; ask an owner to change the policy");
      }

      const secret = decryptSecret(deps, row);
      const code = input.code.trim();
      let validCode = false;
      if (/^\d{6}$/.test(code)) {
        validCode = verifyTotp(secret, code) !== null;
      }
      if (!validCode) {
        const hash = sha256(normalizeRecoveryCode(code));
        const matches = await deps.db
          .select()
          .from(userMfaRecoveryCodes)
          .where(
            and(
              eq(userMfaRecoveryCodes.userId, actor.id),
              eq(userMfaRecoveryCodes.codeHash, hash),
              isNull(userMfaRecoveryCodes.usedAt),
            ),
          )
          .limit(1);
        validCode = matches.length > 0;
      }
      if (!validCode) {
        await auditMfa(deps, actor, "mfa.failed", { stage: "disable" }, request.ip);
        throw unauthorized("invalid code");
      }

      await deps.db.transaction(async (tx) => {
        await tx.delete(userMfaRecoveryCodes).where(eq(userMfaRecoveryCodes.userId, actor.id));
        await tx.delete(userMfa).where(eq(userMfa.userId, actor.id));
      });

      await auditMfa(deps, actor, "mfa.disable", {}, request.ip);
      return { ok: true };
    },
  );

  app.post(
    "/api/auth/mfa/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parse(mfaLoginSchema, request.body);
      const userId = await verifyMfaChallenge(deps.env, input.challengeToken, "login");
      if (!userId) throw unauthorized("invalid or expired challenge");

      const context = await loadUserAuthContext(deps, userId);
      const actor: UserActor = {
        type: "user",
        id: context.user.id,
        name: context.user.name,
        email: context.user.email,
        role: context.member.role,
        orgId: context.org.id,
        orgName: context.org.name,
      };

      const row = await loadMfa(deps, userId);
      if (!row?.enabled) throw unauthorized("MFA is not enabled for this account");

      const secret = decryptSecret(deps, row);
      const code = input.code.trim();
      let step: number | null = null;
      let usedRecovery = false;

      if (/^\d{6}$/.test(code)) {
        const candidate = verifyTotp(secret, code);
        if (candidate !== null && (row.lastUsedStep === null || candidate > row.lastUsedStep)) {
          step = candidate;
        }
      }

      if (step === null) {
        const hash = sha256(normalizeRecoveryCode(code));
        const matches = await deps.db
          .select()
          .from(userMfaRecoveryCodes)
          .where(
            and(
              eq(userMfaRecoveryCodes.userId, userId),
              eq(userMfaRecoveryCodes.codeHash, hash),
              isNull(userMfaRecoveryCodes.usedAt),
            ),
          )
          .limit(1);
        if (matches[0]) {
          usedRecovery = true;
          await deps.db
            .update(userMfaRecoveryCodes)
            .set({ usedAt: new Date() })
            .where(
              and(eq(userMfaRecoveryCodes.userId, userId), eq(userMfaRecoveryCodes.codeHash, hash)),
            );
        }
      }

      if (step === null && !usedRecovery) {
        await auditMfa(deps, actor, "mfa.failed", { stage: "login" }, request.ip);
        throw unauthorized("invalid code");
      }

      if (step !== null) {
        await deps.db.update(userMfa).set({ lastUsedStep: step }).where(eq(userMfa.userId, userId));
      }

      const token = await createSession(deps.db, userId);
      setSessionCookie(reply, token, deps.env.secureCookies);
      await auditMfa(
        deps,
        actor,
        usedRecovery ? "mfa.recovery_used" : "mfa.login",
        { remaining: await unusedRecoveryCodes(deps, userId) },
        request.ip,
      );

      return {
        token,
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
        recoveryCodesRemaining: await unusedRecoveryCodes(deps, userId),
        user: {
          id: actor.id,
          email: actor.email,
          name: actor.name,
          role: actor.role,
          orgId: actor.orgId,
          orgName: actor.orgName,
        },
      };
    },
  );
}
