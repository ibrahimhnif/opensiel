import { and, count, eq, gte } from "drizzle-orm";
import { auditLogs, identityScopes } from "./db/schema.js";
import type { IdentityRow, ProjectRow } from "./db/schema.js";
import { ipAllowed, signMachineToken } from "./auth.js";
import { AppError, forbidden } from "./errors.js";
import { sha256 } from "./crypto.js";
import { writeAudit } from "./audit.js";
import type { Deps } from "./types.js";

export interface IssuedIdentityToken {
  accessToken: string;
  expiresIn: number;
  tokenType: "Bearer";
}

export async function issueIdentityToken(
  deps: Deps,
  identity: IdentityRow,
  project: ProjectRow,
  ip: string,
  method: string,
): Promise<IssuedIdentityToken> {
  if (!ipAllowed(identity.ipAllowlist, ip)) {
    await writeAudit(deps, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: "machine",
      actorId: identity.id,
      actorName: identity.name,
      action: "identity.token.denied",
      resourceType: "identity",
      resourceId: identity.id,
      metadata: { reason: "ip_not_allowed", ip, method },
      ip,
    });
    throw forbidden("this identity may not issue tokens from this address");
  }

  if (identity.hourlyTokenCap !== null) {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const tally = await deps.db
      .select({ total: count() })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "identity.token"),
          eq(auditLogs.resourceId, identity.id),
          gte(auditLogs.createdAt, since),
        ),
      );
    if (Number(tally[0]?.total ?? 0) >= identity.hourlyTokenCap) {
      throw new AppError(
        429,
        "token issuance limit reached for this identity",
        "token_limit_reached",
      );
    }
  }

  const scopes = await deps.db
    .select()
    .from(identityScopes)
    .where(eq(identityScopes.identityId, identity.id));

  const accessToken = await signMachineToken(
    deps.env,
    {
      identityId: identity.id,
      name: identity.name,
      role: identity.role,
      projectId: identity.projectId,
      orgId: project.orgId,
      envIds: scopes.map((scope) => scope.environmentId),
      tokenVersion: identity.tokenVersion,
    },
    identity.tokenTtlSeconds,
  );

  await writeAudit(deps, {
    orgId: project.orgId,
    projectId: project.id,
    actorType: "machine",
    actorId: identity.id,
    actorName: identity.name,
    action: "identity.token",
    resourceType: "identity",
    resourceId: identity.id,
    metadata: {
      method,
      clientId: sha256(identity.clientId).slice(0, 12),
      ttlSeconds: identity.tokenTtlSeconds,
      ip,
    },
    ip,
  });

  return {
    accessToken,
    expiresIn: identity.tokenTtlSeconds,
    tokenType: "Bearer",
  };
}
