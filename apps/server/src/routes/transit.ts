import type { FastifyInstance } from "fastify";
import {
  createTransitKeySchema,
  transitDecryptSchema,
  transitEncryptSchema,
  transitKeyNameSchema,
} from "@opensiel/shared";
import { requireActor } from "../auth.js";
import { assertCanAdmin, assertCanWrite, loadProject } from "../access.js";
import { parse } from "../errors.js";
import { sha256 } from "../crypto.js";
import { writeAudit } from "../audit.js";
import {
  createTransitKey,
  decryptWithTransitKey,
  encryptWithTransitKey,
  listTransitKeys,
  rotateTransitKey,
} from "../transit.js";
import type { Deps } from "../types.js";

const DEFAULT_KEY = "default";

export function registerTransitRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/crypto/keys", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    return { keys: await listTransitKeys(deps, project.id) };
  });

  app.post("/api/projects/:projectId/crypto/keys", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(createTransitKeySchema, request.body);
    const key = await createTransitKey(deps, project, input.name);

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "transit.key.create",
      resourceType: "transit_key",
      resourceId: input.name,
      metadata: { name: input.name, version: key.version },
      ip: request.ip,
    });

    return reply.code(201).send({ key });
  });

  app.post("/api/projects/:projectId/crypto/keys/:name/rotate", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, name } = request.params as { projectId: string; name: string };
    const project = await loadProject(deps, actor, projectId);
    const keyName = parse(transitKeyNameSchema, name);
    const key = await rotateTransitKey(deps, project, keyName);

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "transit.key.rotate",
      resourceType: "transit_key",
      resourceId: keyName,
      metadata: { name: keyName, version: key.version },
      ip: request.ip,
    });

    return { key };
  });

  app.post(
    "/api/projects/:projectId/crypto/encrypt",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = await requireActor(deps, request);
      assertCanWrite(actor);
      const { projectId } = request.params as { projectId: string };
      const project = await loadProject(deps, actor, projectId);
      const input = parse(transitEncryptSchema, request.body);
      const name = input.key ?? DEFAULT_KEY;
      const result = await encryptWithTransitKey(deps, project, {
        name,
        plaintext: input.plaintext,
        context: input.context,
      });

      await writeAudit(deps, {
        orgId: actor.orgId,
        projectId: project.id,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: "transit.encrypt",
        resourceType: "transit_key",
        resourceId: name,
        metadata: {
          key: name,
          keyVersion: result.keyVersion,
          contextHash: input.context ? sha256(input.context).slice(0, 16) : null,
          bytes: input.plaintext.length,
        },
        ip: request.ip,
      });

      return {
        ciphertext: result.ciphertext,
        key: name,
        keyVersion: result.keyVersion,
        algorithm: "AES-256-GCM",
      };
    },
  );

  app.post(
    "/api/projects/:projectId/crypto/decrypt",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = await requireActor(deps, request);
      assertCanWrite(actor);
      const { projectId } = request.params as { projectId: string };
      const project = await loadProject(deps, actor, projectId);
      const input = parse(transitDecryptSchema, request.body);
      const result = await decryptWithTransitKey(deps, project, input);

      await writeAudit(deps, {
        orgId: actor.orgId,
        projectId: project.id,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: "transit.decrypt",
        resourceType: "transit_key",
        resourceId: result.key,
        metadata: {
          key: result.key,
          keyVersion: result.keyVersion,
          contextHash: input.context ? sha256(input.context).slice(0, 16) : null,
          bytes: result.plaintext.length,
        },
        ip: request.ip,
      });

      return { plaintext: result.plaintext, key: result.key, keyVersion: result.keyVersion };
    },
  );
}
