import { useCallback, useEffect, useState } from "react";
import type { InviteDto, MemberDto, Role } from "@opensiel/shared";
import { api, errorMessage } from "../api";

interface OrgData {
  org: { id: string; name: string; slug: string };
  members: MemberDto[];
  currentUserId: string;
  canManage: boolean;
  isOwner: boolean;
}

const ROLE_HINT: Record<Role, string> = {
  owner: "full control, can delete the organization",
  admin: "manage projects, environments, identities, members",
  member: "read and write secrets",
  viewer: "read secrets only",
};

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
    if (!window.confirm(`Remove ${member.name} from the organization? Their sessions are revoked.`)) return;
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

  if (!data) {
    return <section className="view">{error ? <div className="banner error-banner">{error}</div> : <p className="muted">loading…</p>}</section>;
  }

  const assignableRoles: Role[] = data.isOwner
    ? ["owner", "admin", "member", "viewer"]
    : ["admin", "member", "viewer"];

  return (
    <section className="view">
      <div className="toolbar">
        <div>
          <h2>{data.org.name} members</h2>
          <p className="muted small">
            {data.members.length} member{data.members.length === 1 ? "" : "s"} · {data.org.slug}
          </p>
        </div>
        <button onClick={() => void load()}>refresh</button>
      </div>

      {notice && (
        <div className="banner info-banner">
          {notice}
          <button className="link" onClick={() => setNotice("")}>
            dismiss
          </button>
        </div>
      )}
      {error && (
        <div className="banner error-banner">
          {error}
          <button className="link" onClick={() => setError("")}>
            dismiss
          </button>
        </div>
      )}

      {inviteLink && (
        <div className="banner secret-banner">
          <div>
            <strong>Invite link (shown once, valid for 7 days)</strong>
            <div className="credential">
              <code>{inviteLink}</code>
            </div>
            <p className="muted small">
              There is no SMTP configured, so copy this link and send it yourself.
            </p>
          </div>
          <div className="toolbar-actions">
            <button className="small" onClick={() => void copyLink()}>
              copy
            </button>
            <button className="link" onClick={() => setInviteLink("")}>
              dismiss
            </button>
          </div>
        </div>
      )}

      {data.canManage && (
        <form className="card invite-form" onSubmit={invite}>
          <div className="invite-fields">
            <label>
              Invite by email
              <input
                type="email"
                placeholder="teammate@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              Role
              <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {assignableRoles.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate} — {ROLE_HINT[candidate]}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "creating…" : "create invite"}
            </button>
          </div>
        </form>
      )}

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((member) => {
              const isSelf = member.userId === data.currentUserId;
              const locked = !data.canManage || isSelf || (member.role === "owner" && !data.isOwner);
              return (
                <tr key={member.userId}>
                  <td>
                    {member.name} {isSelf && <span className="pill">you</span>}
                  </td>
                  <td className="muted small">{member.email}</td>
                  <td>
                    {data.canManage ? (
                      <select
                        className="role-select"
                        value={member.role}
                        disabled={locked}
                        onChange={(event) => void changeRole(member, event.target.value as Role)}
                      >
                        {assignableRoles.map((candidate) => (
                          <option key={candidate} value={candidate}>
                            {candidate}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="pill">{member.role}</span>
                    )}
                  </td>
                  <td className="muted small">{formatDate(member.createdAt)}</td>
                  <td className="right actions">
                    <button
                      className="small danger"
                      disabled={locked}
                      onClick={() => void remove(member)}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.canManage && (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Pending invite</th>
                <th>Role</th>
                <th>Invited by</th>
                <th>Expires</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id}>
                  <td>{invite.email}</td>
                  <td>
                    <span className="pill">{invite.role}</span>
                  </td>
                  <td className="muted small">{invite.invitedByName}</td>
                  <td className="muted small">{formatDate(invite.expiresAt)}</td>
                  <td className="right actions">
                    <button className="small danger" onClick={() => void revokeInvite(invite)}>
                      revoke
                    </button>
                  </td>
                </tr>
              ))}
              {invites.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No pending invites.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
