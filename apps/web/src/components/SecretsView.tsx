import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectDto, SecretDto, SecretVersionDto } from "@opensiel/shared";
import { api, errorMessage } from "../api";

interface Props {
  project: ProjectDto;
  env: string;
}

interface EditorState {
  key: string;
  value: string;
  path: string;
  comment: string;
  isNew: boolean;
}

interface HistoryState {
  key: string;
  path: string;
  versions: SecretVersionDto[];
}

export function SecretsView({ project, env }: Props) {
  const [rows, setRows] = useState<SecretDto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ secrets: SecretDto[] }>(
        `/api/projects/${project.id}/secrets?env=${encodeURIComponent(env)}`,
      );
      setRows(result.secrets);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [project.id, env]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.key.toLowerCase().includes(needle) ||
        row.path.toLowerCase().includes(needle) ||
        row.value.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  function rowId(row: SecretDto) {
    return `${row.path}:${row.key}`;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{
        secret?: { version: number };
        changeRequest?: { id: string; requiredApprovals: number };
      }>(`/api/projects/${project.id}/secrets`, {
        key: editor.key.trim(),
        value: editor.value,
        env,
        path: editor.path.trim() || "/",
        comment: editor.comment.trim() || undefined,
      });
      setEditor(null);
      setNotice(
        result.changeRequest
          ? `change submitted for approval (${result.changeRequest.id.slice(0, 8)})`
          : "secret saved",
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: SecretDto) {
    if (!window.confirm(`Delete ${row.key} from ${env}? Version history is kept.`)) return;
    try {
      const params = new URLSearchParams({ env, path: row.path });
      const result = await api.del<{ ok?: boolean; changeRequest?: { id: string } }>(
        `/api/projects/${project.id}/secrets/${encodeURIComponent(row.key)}?${params}`,
      );
      setNotice(
        result.changeRequest
          ? `delete submitted for approval (${result.changeRequest.id.slice(0, 8)})`
          : "secret deleted",
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openHistory(row: SecretDto) {
    try {
      const params = new URLSearchParams({ env, path: row.path });
      const result = await api.get<{ versions: SecretVersionDto[] }>(
        `/api/projects/${project.id}/secrets/${encodeURIComponent(row.key)}/versions?${params}`,
      );
      setHistory({ key: row.key, path: row.path, versions: result.versions });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function rollback(version: number) {
    if (!history) return;
    try {
      const result = await api.post<{ secret?: { version: number }; changeRequest?: { id: string } }>(
        `/api/projects/${project.id}/secrets/${encodeURIComponent(history.key)}/rollback`,
        { version, env, path: history.path },
      );
      setHistory(null);
      setNotice(
        result.changeRequest
          ? `rollback submitted for approval (${result.changeRequest.id.slice(0, 8)})`
          : `rolled back ${history.key} to v${version}`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("copied to clipboard");
    } catch {
      setError("clipboard is not available");
    }
  }

  return (
    <section className="view">
      <div className="toolbar">
        <input
          className="search"
          placeholder="search keys, paths, values…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="toolbar-actions">
          <button onClick={() => void load()} disabled={loading}>
            {loading ? "refreshing…" : "refresh"}
          </button>
          <button
            className="primary"
            onClick={() => setEditor({ key: "", value: "", path: "/", comment: "", isNew: true })}
          >
            New secret
          </button>
        </div>
      </div>

      {project.environments.find((environment) => environment.slug === env)?.approvalRequired && (
        <div className="banner info-banner">
          Changes to <code>{env}</code> require{" "}
          {project.environments.find((environment) => environment.slug === env)?.requiredApprovals}{" "}
          approval(s) before they are applied.
        </div>
      )}

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

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Version</th>
              <th>Updated</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const id = rowId(row);
              const isRevealed = Boolean(revealed[id]);
              return (
                <tr key={id}>
                  <td>
                    <code>{row.key}</code>
                    {row.path !== "/" && <div className="muted small">{row.path}</div>}
                  </td>
                  <td className="value-cell">
                    <span className={isRevealed ? "value" : "value masked"}>
                      {isRevealed ? row.value : "••••••••••••"}
                    </span>
                    <button
                      className="icon"
                      title={isRevealed ? "hide" : "reveal"}
                      onClick={() =>
                        setRevealed((current) => ({ ...current, [id]: !current[id] }))
                      }
                    >
                      {isRevealed ? "◉" : "◎"}
                    </button>
                    <button className="icon" title="copy" onClick={() => void copy(row.value)}>
                      ⧉
                    </button>
                  </td>
                  <td>
                    <span className="pill">v{row.version}</span>
                  </td>
                  <td className="muted small">{formatDate(row.updatedAt)}</td>
                  <td className="right actions">
                    <button
                      className="small"
                      onClick={() =>
                        setEditor({
                          key: row.key,
                          value: row.value,
                          path: row.path,
                          comment: "",
                          isNew: false,
                        })
                      }
                    >
                      edit
                    </button>
                    <button className="small" onClick={() => void openHistory(row)}>
                      history
                    </button>
                    <button className="small danger" onClick={() => void remove(row)}>
                      delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {rows.length === 0 ? `No secrets in ${env} yet.` : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editor && (
        <div className="overlay" onClick={() => setEditor(null)}>
          <form className="modal" onClick={(event) => event.stopPropagation()} onSubmit={save}>
            <h2>{editor.isNew ? "New secret" : `Edit ${editor.key}`}</h2>
            <p className="muted small">
              Writing creates a new immutable version in <code>{env}</code>.
            </p>

            <label>
              Key
              <input
                autoFocus
                value={editor.key}
                disabled={!editor.isNew}
                onChange={(event) => setEditor({ ...editor, key: event.target.value })}
                placeholder="DATABASE_URL"
                required
              />
            </label>

            <label>
              Value
              <textarea
                rows={6}
                value={editor.value}
                onChange={(event) => setEditor({ ...editor, value: event.target.value })}
                placeholder="postgres://…"
                required
              />
            </label>

            <div className="grid-2">
              <label>
                Folder path
                <input
                  value={editor.path}
                  onChange={(event) => setEditor({ ...editor, path: event.target.value })}
                  placeholder="/"
                />
              </label>
              <label>
                Comment <span className="muted small">(optional)</span>
                <input
                  value={editor.comment}
                  onChange={(event) => setEditor({ ...editor, comment: event.target.value })}
                  placeholder="rotated by hand"
                />
              </label>
            </div>

            <div className="modal-actions">
              <button type="button" onClick={() => setEditor(null)}>
                cancel
              </button>
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "saving…" : "save version"}
              </button>
            </div>
          </form>
        </div>
      )}

      {history && (
        <div className="overlay" onClick={() => setHistory(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>
              History · <code>{history.key}</code>
            </h2>
            <p className="muted small">
              {history.path} · {env}
            </p>
            <div className="history-list">
              {history.versions.map((version) => (
                <div key={version.version} className="history-row">
                  <div>
                    <span className="pill">v{version.version}</span>{" "}
                    {version.current && <span className="pill current">current</span>}
                    <div className="muted small">{formatDate(version.createdAt)}</div>
                  </div>
                  <div className="muted small">
                    {version.comment ?? "—"} · by {version.createdByType}
                  </div>
                  <button
                    className="small"
                    disabled={version.current}
                    onClick={() => void rollback(version.version)}
                  >
                    rollback
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setHistory(null)}>
                close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
