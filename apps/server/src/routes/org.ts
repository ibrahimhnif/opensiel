import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { inviteMemberSchema, updateMemberSchema } from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import { randomToken, sha256 } from "../crypto.js";
import { conflict, forbidden, notFound, parse } from "../errors.js";
import { orgInvites, orgMembers, orgs, sessions, users } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import type { Actor, Deps, UserActor } from "../types.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function assertCanManage(actor: UserActor): void {
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw forbidden("owner or admin role required");
  }
}

function assertOwner(actor: UserActor): void {
  if (actor.role !== "owner") throw forbidden("only an owner can grant or change the owner role");
}

async function memberRows(deps: Deps, orgId: string) {
  return deps.db
    .select({ user: users, member: orgMembers })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId))
    .orderBy(orgMembers.createdAt);
}

async function ownerCount(deps: Deps, orgId: string): Promise<number> {
  const rows = await deps.db
    .select({ total: count() })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")));
  return Number(rows[0]?.total ?? 0);
}

async function auditMember(
  deps: Deps,
  actor: Actor,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  ip: string,
) {
  await writeAudit(deps, {
    orgId: actor.orgId,
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action,
    resourceType: "member",
    resourceId,
    metadata,
    ip,
  });
}

export function registerOrgRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/org", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    const orgRows = await deps.db.select().from(orgs).where(eq(orgs.id, actor.orgId)).limit(1);
    const org = orgRows[0];
    if (!org) throw notFound("organization not found");

    const rows = await memberRows(deps, org.id);
    return {
      org: { id: org.id, name: org.name, slug: org.slug },
      members: rows.map((row) => ({
        userId: row.user.id,
        email: row.user.email,
        name: row.user.name,
        role: row.member.role,
        createdAt: row.member.createdAt.toISOString(),
      })),
      currentUserId: actor.id,
      canManage: actor.role === "owner" || actor.role === "admin",
      isOwner: actor.role === "owner",
    };
  });

  app.post("/api/org/invites", async (request, reply) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanManage(actor);
    const input = parse(inviteMemberSchema, request.body);
    if (input.role === "owner") assertOwner(actor);

    const existingMember = await deps.db
      .select({ userId: users.id })
      .from(users)
      .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
      .where(and(eq(users.email, input.email), eq(orgMembers.orgId, actor.orgId)))
      .limit(1);
    if (existingMember.length > 0) throw conflict("that email is already a member");

    const pending = await deps.db
      .select({ id: orgInvites.id })
      .from(orgInvites)
      .where(
        and(
          eq(orgInvites.orgId, actor.orgId),
          eq(orgInvites.email, input.email),
          isNull(orgInvites.acceptedAt),
          gt(orgInvites.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (pending.length > 0) throw conflict("an invite is already pending for that email");

    const token = randomToken(32);
    const inserted = await deps.db
      .insert(orgInvites)
      .values({
        orgId: actor.orgId,
        email: input.email,
        role: input.role,
        tokenHash: sha256(token),
        invitedBy: actor.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    const invite = inserted[0];

    await auditMember(
      deps,
      actor,
      "org.invite.create",
      invite.id,
      {
        email: invite.email,
        role: invite.role,
      },
      request.ip,
    );

    return reply.code(201).send({
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        invitedByName: actor.name,
        expiresAt: invite.expiresAt.toISOString(),
        createdAt: invite.createdAt.toISOString(),
      },
      token,
      acceptPath: `/invite?token=${token}`,
    });
  });

  app.get("/api/org/invites", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanManage(actor);

    const rows = await deps.db
      .select({ invite: orgInvites, inviter: users })
      .from(orgInvites)
      .innerJoin(users, eq(users.id, orgInvites.invitedBy))
      .where(and(eq(orgInvites.orgId, actor.orgId), isNull(orgInvites.acceptedAt)))
      .orderBy(desc(orgInvites.createdAt));

    return {
      invites: rows
        .filter((row) => row.invite.expiresAt.getTime() > Date.now())
        .map((row) => ({
          id: row.invite.id,
          email: row.invite.email,
          role: row.invite.role,
          invitedByName: row.inviter.name,
          expiresAt: row.invite.expiresAt.toISOString(),
          createdAt: row.invite.createdAt.toISOString(),
        })),
    };
  });

  app.delete("/api/org/invites/:inviteId", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanManage(actor);
    const { inviteId } = request.params as { inviteId: string };

    const rows = await deps.db
      .select()
      .from(orgInvites)
      .where(and(eq(orgInvites.id, inviteId), eq(orgInvites.orgId, actor.orgId)))
      .limit(1);
    const invite = rows[0];
    if (!invite) throw notFound("invite not found");

    await deps.db.delete(orgInvites).where(eq(orgInvites.id, invite.id));
    await auditMember(
      deps,
      actor,
      "org.invite.revoke",
      invite.id,
      { email: invite.email },
      request.ip,
    );
    return { ok: true };
  });

  app.patch("/api/org/members/:userId", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanManage(actor);
    const { userId } = request.params as { userId: string };
    const input = parse(updateMemberSchema, request.body);

    const rows = await deps.db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw notFound("member not found");

    if (target.role === "owner" || input.role === "owner") assertOwner(actor);

    if (target.role === "owner" && input.role !== "owner") {
      const owners = await ownerCount(deps, actor.orgId);
      if (owners <= 1) throw conflict("an organization must keep at least one owner");
    }

    await deps.db
      .update(orgMembers)
      .set({ role: input.role })
      .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)));

    await auditMember(
      deps,
      actor,
      "org.member.role",
      userId,
      {
        from: target.role,
        to: input.role,
      },
      request.ip,
    );

    return { ok: true };
  });

  app.delete("/api/org/members/:userId", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanManage(actor);
    const { userId } = request.params as { userId: string };

    if (userId === actor.id) throw conflict("you cannot remove yourself");

    const rows = await deps.db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw notFound("member not found");

    if (target.role === "owner") assertOwner(actor);
    if (target.role === "owner") {
      const owners = await ownerCount(deps, actor.orgId);
      if (owners <= 1) throw conflict("an organization must keep at least one owner");
    }

    await deps.db
      .delete(orgMembers)
      .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)));
    await deps.db.delete(sessions).where(eq(sessions.userId, userId));

    await auditMember(deps, actor, "org.member.remove", userId, {}, request.ip);
    return { ok: true };
  });
}
