import { auditLogs } from "./db/schema.js";
import type { Deps } from "./types.js";

export interface AuditInput {
  orgId: string;
  projectId?: string | null;
  actorType: "user" | "machine" | "system";
  actorId: string;
  actorName: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function writeAudit(deps: Deps, input: AuditInput): Promise<void> {
  await deps.db.insert(auditLogs).values({
    orgId: input.orgId,
    projectId: input.projectId ?? null,
    actorType: input.actorType,
    actorId: input.actorId,
    actorName: input.actorName,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: input.metadata ?? {},
    ip: input.ip ?? null,
  });
}
