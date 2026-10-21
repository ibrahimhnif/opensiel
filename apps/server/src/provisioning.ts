import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { createProject } from "./projects-service.js";
import { slugify, uniqueOrgSlug } from "./access.js";
import { hashPassword } from "./auth.js";
import { randomToken } from "./crypto.js";
import { forbidden } from "./errors.js";
import { orgInvites, orgMembers, orgs, users } from "./db/schema.js";
import type { Deps } from "./types.js";

export interface Provisioned {
  userId: string;
  userName: string;
  orgId: string;
  orgName: string;
}

export interface ProvisionOptions {
  autoCreate: boolean;
}

export async function provisionUser(
  deps: Deps,
  config: ProvisionOptions,
  email: string,
  name: string,
): Promise<Provisioned> {
  const existingRows = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
  let user = existingRows[0];

  if (user) {
    const membership = await deps.db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, user.id))
      .limit(1);
    if (membership[0]) {
      const orgRows = await deps.db.select().from(orgs).where(eq(orgs.id, membership[0].orgId)).limit(1);
      if (orgRows[0]) {
        return { userId: user.id, userName: user.name, orgId: orgRows[0].id, orgName: orgRows[0].name };
      }
    }
  }

  const invites = await deps.db
    .select({ invite: orgInvites, org: orgs })
    .from(orgInvites)
    .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
    .where(
      and(
        eq(orgInvites.email, email),
        isNull(orgInvites.acceptedAt),
        gt(orgInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(orgInvites.createdAt))
    .limit(1);

  const invite = invites[0];

  if (!user) {
    if (!invite && !config.autoCreate) {
      throw forbidden("no account or invite exists for this email");
    }
    const passwordHash = await hashPassword(randomToken(32));
    try {
      const inserted = await deps.db
        .insert(users)
        .values({ email, passwordHash, name })
        .returning();
      user = inserted[0];
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
        const retry = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
        user = retry[0];
        if (!user) throw error;
      } else {
        throw error;
      }
    }
  }

  if (invite) {
    await deps.db.transaction(async (tx) => {
      await tx
        .insert(orgMembers)
        .values({ orgId: invite.org.id, userId: user!.id, role: invite.invite.role })
        .onConflictDoNothing();
      await tx
        .update(orgInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(orgInvites.id, invite.invite.id));
    });
    return {
      userId: user.id,
      userName: user.name,
      orgId: invite.org.id,
      orgName: invite.org.name,
    };
  }

  if (!config.autoCreate) {
    throw forbidden("no account or invite exists for this email");
  }

  const orgSlug = await uniqueOrgSlug(deps.db, slugify(`${name || email}-org`));
  const orgRows = await deps.db
    .insert(orgs)
    .values({ name: `${name || email}'s org`, slug: orgSlug })
    .returning();
  const org = orgRows[0];

  await deps.db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  await createProject(deps, org.id, "default");

  return { userId: user.id, userName: user.name, orgId: org.id, orgName: org.name };
}
