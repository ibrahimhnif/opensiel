import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { scanSchema } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import { assertServerManaged, loadProject } from "../access.js";
import { forbidden, parse } from "../errors.js";
import { environments } from "../db/schema.js";
import { loadEnvironmentSecrets } from "../secret-read.js";
import { scanText } from "../scan.js";
import type { StoredSecretInput } from "../scan.js";
import { writeAudit } from "../audit.js";
import { paginate, paginationSchema } from "../pagination.js";
import type { Deps } from "../types.js";

export function registerScanRoutes(app: FastifyInstance, deps: Deps): void {
  app.post(
    "/api/projects/:projectId/scan",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = await requireActor(deps, request);
      if (actor.type !== "user") throw forbidden("a user session is required");
      const { projectId } = request.params as { projectId: string };
      const input = parse(scanSchema, request.body);
      const project = await loadProject(deps, actor, projectId);
      assertServerManaged(project);

      const envRows = await deps.db
        .select()
        .from(environments)
        .where(eq(environments.projectId, project.id))
        .orderBy(environments.position);

      const stored: StoredSecretInput[] = [];
      for (const environment of envRows) {
        const rows = await loadEnvironmentSecrets(deps, project, environment);
        for (const row of rows) {
          stored.push({
            environment: environment.slug,
            path: row.path,
            key: row.key,
            value: row.value,
          });
        }
      }

      const findings = scanText(input.contents, stored);
      const query = parse(paginationSchema, request.query);
      const page = paginate(findings, query);

      await writeAudit(deps, {
        orgId: actor.orgId,
        projectId: project.id,
        actorType: "user",
        actorId: actor.id,
        actorName: actor.name,
        action: "secret.scan",
        resourceType: "project",
        resourceId: project.id,
        metadata: {
          findings: findings.length,
          characters: input.contents.length,
          environments: envRows.length,
        },
        ip: request.ip,
      });

      return {
        findings: page.items,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        characters: input.contents.length,
        scannedEnvironments: envRows.length,
        scannedSecrets: stored.length,
      };
    },
  );
}
