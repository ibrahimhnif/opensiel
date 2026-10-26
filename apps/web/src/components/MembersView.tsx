import { useEffect, useState } from "react";
import type { InviteDto, MemberDto, Role } from "@opensiel/shared";
import { Copy, Loader2, RefreshCw, UserPlus, X } from "lucide-react";
import { api, errorMessage } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Pagination } from "./Pagination";
import { useServerList } from "../hooks/useServerList";
import { notify } from "../lib/notify";
import { useToastMessage } from "../hooks/useToastMessage";
import { useConfirm } from "./ConfirmProvider";
import { KeyRotationCard } from "./KeyRotationCard";

interface OrgData {
  org: { id: string; name: string; slug: string };
  members: MemberDto[];
  membersTotal: number;
  currentUserId: string;
  canManage: boolean;
  isOwner: boolean;
}

export function MembersView() {
  const confirm = useConfirm();
  const [orgInfo, setOrgInfo] = useState<{
    org: OrgData["org"];
    currentUserId: string;
    canManage: boolean;
    isOwner: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  useToastMessage("success", notice, setNotice);
  useToastMessage("error", error, setError);

  const memberList = useServerList<MemberDto>({
    key: "org-members",
    pageSize: 10,
    initialSort: "name",
    initialOrder: "asc",
    fetcher: async ({ limit, offset, q, sort, order }) => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        order,
      });
      if (q) params.set("q", q);
      if (sort) params.set("sort", sort);
      const result = await api.get<OrgData>(`/api/org?${params}`);
      setOrgInfo({
        org: result.org,
        currentUserId: result.currentUserId,
        canManage: result.canManage,
        isOwner: result.isOwner,
      });
      return { items: result.members, total: result.membersTotal };
    },
  });

  const inviteList = useServerList<InviteDto>({
    key: `invites:${orgInfo?.canManage ?? false}`,
    pageSize: 10,
    initialSort: "createdAt",
    initialOrder: "desc",
    fetcher: async ({ limit, offset, q, sort, order }) => {
      if (!orgInfo?.canManage) return { items: [], total: 0 };
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        order,
      });
      if (q) params.set("q", q);
      if (sort) params.set("sort", sort);
      const result = await api.get<{ invites: InviteDto[]; total: number }>(
        `/api/org/invites?${params}`,
      );
      return { items: result.invites, total: result.total };
    },
  });

  useEffect(() => {
    if (memberList.error) notify.error(memberList.error);
  }, [memberList.error]);
  useEffect(() => {
    if (inviteList.error) notify.error(inviteList.error);
  }, [inviteList.error]);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ invite: InviteDto; acceptPath: string }>("/api/org/invites", {
        email: email.trim(),
        role,
      });
      setInviteLink(`${window.location.origin}${result.acceptPath}`);
      setEmail("");
      setRole("member");
      setNotice(`invite created for ${result.invite.email}`);
      memberList.reload();
      inviteList.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(member: MemberDto, nextRole: Role) {
    try {
      await api.patch(`/api/org/members/${member.userId}`, { role: nextRole });
      setNotice(`${member.name} is now ${nextRole}`);
      memberList.reload();
      inviteList.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(member: MemberDto) {
    if (
      !(await confirm({
        title: `Remove ${member.name}?`,
        description: "Their sessions are revoked immediately.",
        confirmLabel: "remove",
        destructive: true,
      }))
    )
      return;
    try {
      await api.del(`/api/org/members/${member.userId}`);
      setNotice(`${member.name} removed`);
      memberList.reload();
      inviteList.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revokeInvite(invite: InviteDto) {
    try {
      await api.del(`/api/org/invites/${invite.id}`);
      setNotice(`invite for ${invite.email} revoked`);
      memberList.reload();
      inviteList.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setNotice("invite link copied");
    } catch {
      setError("clipboard is not available");
    }
  }

  const assignableRoles: Role[] = orgInfo?.isOwner
    ? ["owner", "admin", "member", "viewer"]
    : ["admin", "member", "viewer"];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {orgInfo ? `${orgInfo.org.name} members` : "Members"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {orgInfo
              ? `${memberList.total} member${memberList.total === 1 ? "" : "s"} · ${orgInfo.org.slug}`
              : "loading…"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 w-44"
            placeholder="Search name, email, role…"
            value={memberList.query}
            onChange={(event) => memberList.setQuery(event.target.value)}
          />
          <Select value={memberList.sort || "name"} onValueChange={memberList.setSort}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">name</SelectItem>
              <SelectItem value="email">email</SelectItem>
              <SelectItem value="role">role</SelectItem>
              <SelectItem value="createdAt">joined</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => memberList.reload()}>
            <RefreshCw className="size-4" /> refresh
          </Button>
        </div>
      </div>

      {inviteLink && (
        <div className="border-primary/40 bg-primary/10 text-primary rounded-lg border px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <p className="font-medium">Invite link (shown once, valid for 7 days)</p>
              <code className="block break-all bg-transparent p-0 text-xs">{inviteLink}</code>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void copyLink()}>
                  <Copy className="size-3.5" /> copy
                </Button>
                <span className="text-xs opacity-80">
                  No SMTP is configured, so send this link yourself.
                </span>
              </div>
            </div>
            <button onClick={() => setInviteLink("")} aria-label="dismiss" className="opacity-70">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {orgInfo?.canManage && (
        <Card className="p-4">
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={invite}>
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-email-input">Invite by email</Label>
              <Input
                id="invite-email-input"
                type="email"
                placeholder="teammate@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="w-full space-y-2 sm:w-44">
              <Label>Role</Label>
              <Select value={role} onValueChange={(value) => setRole(value as Role)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {candidate}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
              create invite
            </Button>
          </form>
        </Card>
      )}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memberList.items.map((member) => {
              const isSelf = member.userId === orgInfo?.currentUserId;
              const locked =
                !orgInfo?.canManage || isSelf || (member.role === "owner" && !orgInfo?.isOwner);
              return (
                <TableRow key={member.userId}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {member.name}
                      {isSelf && <Badge variant="outline">you</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{member.email}</TableCell>
                  <TableCell>
                    {orgInfo?.canManage ? (
                      <Select
                        value={member.role}
                        disabled={locked}
                        onValueChange={(value) => void changeRole(member, value as Role)}
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {assignableRoles.map((candidate) => (
                            <SelectItem key={candidate} value={candidate}>
                              {candidate}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge>{member.role}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                    {formatDate(member.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn("text-destructive hover:text-destructive")}
                      disabled={locked}
                      onClick={() => void remove(member)}
                    >
                      remove
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {memberList.total === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {memberList.query ? "No matching members." : "No members."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination {...memberList.pagination} />
      </Card>

      {orgInfo?.canManage && (
        <Card className="overflow-hidden py-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-sm font-medium">Pending invites</span>
            <Input
              className="h-8 w-44"
              placeholder="Search invites…"
              value={inviteList.query}
              onChange={(event) => inviteList.setQuery(event.target.value)}
            />
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pending invite</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Invited by</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inviteList.items.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>{invite.email}</TableCell>
                  <TableCell>
                    <Badge>{invite.role}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {invite.invitedByName}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(invite.expiresAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void revokeInvite(invite)}
                    >
                      revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {inviteList.total === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    {inviteList.query ? "No matching invites." : "No pending invites."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pagination {...inviteList.pagination} />
        </Card>
      )}
      {orgInfo?.isOwner && <KeyRotationCard />}
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
