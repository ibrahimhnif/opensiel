import { useCallback, useEffect, useState } from "react";
import type { IdentityDto, ProjectDto } from "@opensiel/shared";
import { api, errorMessage } from "../api";

interface CreatedIdentity {
  name: string;
  clientId: string;
  clientSecret: string;
}

export function IdentitiesView({ project }: { project: ProjectDto }) {
  const [rows, setRows] = useState<IdentityDto[]>([]);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedIdentity | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"viewer" | "member">("viewer");
  const [envIds, setEnvIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ identities: IdentityDto[] }>(
        `/api/projects/${project.id}/identities`,
      );
      setRows(result.identities);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleEnv(id: string) {
    setEnvIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  function openForm() {
    setOpen(true);
    setName("");
    setRole("viewer");
    setEnvIds(project.environments.slice(0, 1).map((environment) => environment.id));
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ identity: IdentityDto & { clientSecret: string } }>(
        `/api/projects/${project.id}/identities`,
        { name: name.trim(), role, environmentIds: envIds },
      );
      setCreated({
        name: result.identity.name,
        clientId: result.identity.clientId,
        clientSecret: result.identity.clientSecret,
      });
      setOpen(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(identity: IdentityDto) {
    if (!window.confirm(`Revoke ${identity.name}? Existing tokens stay valid until they expire (15 min).`))
      return;
    try {
      await api.post(`/api/projects/${project.id}/identities/${identity.id}/revoke`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function envName(id: string): string {
    return project.environments.find((environment) => environment.id === id)?.slug ?? id;
  }

  return (
    <section className="view">
      <div className="toolbar">
        <div>
          <h2>Machine identities</h2>
          <p className="muted small">Client-credentials auth for CI, servers, and local tooling.</p>
        </div>
        <button className="primary" onClick={openForm}>
          New identity
        </button>
      </div>

      {error && (
        <div className="banner error-banner">
          {error}
          <button className="link" onClick={() => setError("")}>
            dismiss
          </button>
        </div>
      )}

      {created && (
        <div className="banner secret-banner">
          <div>
            <strong>Save this secret now — it is shown once.</strong>
            <div className="credential">
              <span className="muted small">client id</span>
              <code>{created.clientId}</code>
            </div>
            <div className="credential">
              <span className="muted small">client secret</span>
              <code>{created.clientSecret}</code>
            </div>
          </div>
          <button className="link" onClick={() => setCreated(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Client ID</th>
              <th>Role</th>
              <th>Environments</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((identity) => (
              <tr key={identity.id}>
                <td>{identity.name}</td>
                <td>
                  <code>{identity.clientId}</code>
                </td>
                <td>
                  <span className="pill">{identity.role}</span>
                </td>
                <td className="muted small">
                  {identity.environmentIds.map(envName).join(", ") || "—"}
                </td>
                <td>
                  {identity.revokedAt ? (
                    <span className="pill danger">revoked</span>
                  ) : (
                    <span className="pill ok">active</span>
                  )}
                </td>
                <td className="right actions">
                  <button
                    className="small danger"
                    disabled={Boolean(identity.revokedAt)}
                    onClick={() => void revoke(identity)}
                  >
                    revoke
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No machine identities yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="overlay" onClick={() => setOpen(false)}>
          <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={create}>
            <h2>New machine identity</h2>
            <label>
              Name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="github-actions"
                required
              />
            </label>

            <label>
              Role
              <select value={role} onChange={(event) => setRole(event.target.value as "viewer" | "member")}>
                <option value="viewer">viewer — read secrets</option>
                <option value="member">member — read and write secrets</option>
              </select>
            </label>

            <fieldset>
              <legend>Environments</legend>
              {project.environments.map((environment) => (
                <label key={environment.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={envIds.includes(environment.id)}
                    onChange={() => toggleEnv(environment.id)}
                  />
                  {environment.slug}
                </label>
              ))}
            </fieldset>

            <div className="modal-actions">
              <button type="button" onClick={() => setOpen(false)}>
                cancel
              </button>
              <button className="primary" type="submit" disabled={busy || envIds.length === 0}>
                {busy ? "creating…" : "create identity"}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
