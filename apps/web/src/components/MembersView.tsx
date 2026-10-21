import { useCallback, useEffect, useState } from "react";
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
import { usePagination } from "../hooks/usePagination";
import { Notice } from "./Notice";
import { KeyRotationCard } from "./KeyRotationCard";

interface OrgData {
  org: { id: string; name: string; slug: string };
  members: MemberDto[];
  currentUserId: string;
  canManage: boolean;
  isOwner: boolean;
}

export function MembersView() {
  const [data, setData] = useState<OrgData | null>(null);
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const org = await api.get<OrgData>("/api/org");
      setData(org);
      setError("");
      if (org.canManage) {
        const pending = await api.get<{ invites: InviteDto[] }>("/api/org/invites");
        setInvites(pending.invites);
      } else {
        setInvites([]);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const memberPagination = usePagination(data?.members ?? [], {
    pageSize: 10,
    resetKey: data?.org.id ?? "",
  });
  const invitePagination = usePagination(invites, {
    pageSize: 10,
    resetKey: data?.org.id ?? "",
  });

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
      await load();
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
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(member: MemberDto) {
    if (!window.confirm(`Remove ${member.name} from the organization? Their sessions are revoked.`))
      return;
    try {
      await api.del(`/api/org/members/${member.userId}`);
      setNotice(`${member.name} removed`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revokeInvite(invite: InviteDto) {
    try {
      await api.del(`/api/org/invites/${invite.id}`);
      setNotice(`invite for ${invite.email} revoked`);
      await load();
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

  const assignableRoles: Role[] = data?.isOwner
    ? ["owner", "admin", "member", "viewer"]
    : ["admin", "member", "viewer"];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{data ? `${data.org.name} members` : "Members"}</h2>
          <p className="text-sm text-muted-foreground">
            {data
              ? `${data.members.length} member${data.members.length === 1 ? "" : "s"} · ${data.org.slug}`
              : "loading…"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-4" /> refresh
        </Button>
      </div>

      {notice && (
        <Notice tone="success" onDismiss={() => setNotice("")}>
          {notice}
        </Notice>
      )}
      {error && (
        <Notice tone="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}

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

      {data?.canManage && (
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
            {memberPagination.pageItems.map((member) => {
              const isSelf = member.userId === data?.currentUserId;
              const locked =
                !data?.canManage || isSelf || (member.role === "owner" && !data?.isOwner);
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
                    {data?.canManage ? (
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
            {data && data.members.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No members.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination
          page={memberPagination.page}
          pageSize={memberPagination.pageSize}
          total={memberPagination.total}
          totalPages={memberPagination.totalPages}
          rangeStart={memberPagination.rangeStart}
          rangeEnd={memberPagination.rangeEnd}
          onPageChange={memberPagination.setPage}
          onPageSizeChange={memberPagination.setPageSize}
        />
      </Card>

      {data?.canManage && (
        <Card className="overflow-hidden py-0">
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
              {invitePagination.pageItems.map((invite) => (
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
              {invites.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No pending invites.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pagination
            page={invitePagination.page}
            pageSize={invitePagination.pageSize}
            total={invitePagination.total}
            totalPages={invitePagination.totalPages}
            rangeStart={invitePagination.rangeStart}
            rangeEnd={invitePagination.rangeEnd}
            onPageChange={invitePagination.setPage}
            onPageSizeChange={invitePagination.setPageSize}
          />
        </Card>
      )}
      {data?.isOwner && <KeyRotationCard />}
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
