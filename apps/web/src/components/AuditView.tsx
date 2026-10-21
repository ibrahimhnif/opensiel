import { useCallback, useEffect, useState } from "react";
import type { AuditLogDto, ProjectDto } from "@opensiel/shared";
import { api, errorMessage } from "../api";

export function AuditView({ project }: { project: ProjectDto }) {
  const [logs, setLogs] = useState<AuditLogDto[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ logs: AuditLogDto[] }>(
        `/api/audit?projectId=${project.id}&limit=100`,
      );
      setLogs(result.logs);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="view">
      <div className="toolbar">
        <div>
          <h2>Audit log</h2>
          <p className="muted small">Reads, writes, rollbacks, and identity usage for this project.</p>
        </div>
        <button onClick={() => void load()}>refresh</button>
      </div>

      {error && <div className="banner error-banner">{error}</div>}

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="muted small">{formatDate(log.createdAt)}</td>
                <td>
                  {log.actorName}
                  <div className="muted small">{log.actorType}</div>
                </td>
                <td>
                  <code>{log.action}</code>
                </td>
                <td className="muted small">{log.resourceType}</td>
                <td className="muted small">
                  {Object.entries(log.metadata)
                    .filter(([, value]) => typeof value !== "object")
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(" · ")}
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No audit entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
