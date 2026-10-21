import { useCallback, useEffect, useState } from "react";
import type { ChangeRequestDto, ChangeRequestStatus, EnvironmentDto, ProjectDto } from "@opensiel/shared";
import { api, errorMessage } from "../api";

interface Props {
  project: ProjectDto;
  currentUserId: string;
  canApprove: boolean;
}

const STATUS_FILTERS: (ChangeRequestStatus | "all")[] = ["pending", "all", "approved", "rejected", "cancelled"];

export function ApprovalsView({ project, currentUserId, canApprove }: Props) {
  const [requests, setRequests] = useState<ChangeRequestDto[]>([]);
  const [filter, setFilter] = useState<ChangeRequestStatus | "all">("pending");
  const [envs, setEnvs] = useState<EnvironmentDto[]>(project.environments);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnvs(project.environments);
  }, [project.environments]);

  const load = useCallback(async () => {
    try {
      const query = filter === "all" ? "" : `?status=${filter}`;
      const result = await api.get<{ changeRequests: ChangeRequestDto[] }>(
        `/api/projects/${project.id}/change-requests${query}`,
      );
      setRequests(result.changeRequests);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(request: ChangeRequestDto, decision: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ applied: boolean }>(
        `/api/projects/${project.id}/change-requests/${request.id}/${decision}`,
      );
      setNotice(
        decision === "reject"
          ? `rejected ${request.key}`
          : result.applied
            ? `approved and applied ${request.key}`
            : `approval recorded for ${request.key}; waiting for more approvals`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(request: ChangeRequestDto) {
    try {
      await api.post(`/api/projects/${project.id}/change-requests/${request.id}/cancel`);
      setNotice(`cancelled ${request.key}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function savePolicy(environment: EnvironmentDto, next: { approvalRequired: boolean; requiredApprovals: number }) {
    try {
      const result = await api.patch<{ environment: EnvironmentDto }>(
        `/api/projects/${project.id}/environments/${environment.id}/policy`,
        next,
      );
      setEnvs((current) =>
        current.map((candidate) =>
          candidate.id === environment.id
            ? { ...candidate, ...result.environment }
            : candidate,
        ),
      );
      setNotice(`policy updated for ${environment.slug}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="view">
      <div className="toolbar">
        <div>
          <h2>Approvals</h2>
          <p className="muted small">
            Changes to environments with approval enabled are applied only after the required
            number of approvals.
          </p>
        </div>
        <div className="toolbar-actions">
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as ChangeRequestStatus | "all")}
          >
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button onClick={() => void load()}>refresh</button>
        </div>
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

      {canApprove && (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Environment</th>
                <th>Require approval</th>
                <th>Approvals needed</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {envs.map((environment) => (
                <PolicyRow
                  key={environment.id}
                  environment={environment}
                  onSave={(next) => void savePolicy(environment, next)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Environment</th>
              <th>Change</th>
              <th>Requested by</th>
              <th>Approvals</th>
              <th>Status</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => {
              const isOwn = request.requestedById === currentUserId;
              const pending = request.status === "pending";
              return (
                <tr key={request.id}>
                  <td>
                    <span className="pill">{request.environmentSlug}</span>
                  </td>
                  <td>
                    <code>{request.action}</code> <strong>{request.key}</strong>
                    {request.path !== "/" && <div className="muted small">{request.path}</div>}
                    {request.comment && <div className="muted small">{request.comment}</div>}
                    {request.targetVersion !== null && (
                      <div className="muted small">target v{request.targetVersion}</div>
                    )}
                  </td>
                  <td>
                    {request.requestedByName}
                    <div className="muted small">{request.requestedByType}</div>
                  </td>
                  <td>
                    <span className="pill">
                      {request.approvals}/{request.requiredApprovals}
                    </span>
                    {request.approvedBy.length > 0 && (
                      <div className="muted small">{request.approvedBy.join(", ")}</div>
                    )}
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        request.status === "approved"
                          ? "ok"
                          : request.status === "rejected"
                            ? "danger"
                            : ""
                      }`}
                    >
                      {request.status}
                    </span>
                  </td>
                  <td className="right actions">
                    {pending && canApprove && !isOwn && (
                      <>
                        <button
                          className="small primary"
                          disabled={busy}
                          onClick={() => void decide(request, "approve")}
                        >
                          approve
                        </button>
                        <button
                          className="small danger"
                          disabled={busy}
                          onClick={() => void decide(request, "reject")}
                        >
                          reject
                        </button>
                      </>
                    )}
                    {pending && (isOwn || canApprove) && (
                      <button className="small" onClick={() => void cancel(request)}>
                        cancel
                      </button>
                    )}
                    {!pending && request.decisionNote && (
                      <span className="muted small">{request.decisionNote}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {requests.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No change requests.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PolicyRow({
  environment,
  onSave,
}: {
  environment: EnvironmentDto;
  onSave: (next: { approvalRequired: boolean; requiredApprovals: number }) => void;
}) {
  const [required, setRequired] = useState(environment.approvalRequired);
  const [count, setCount] = useState(environment.requiredApprovals);

  useEffect(() => {
    setRequired(environment.approvalRequired);
    setCount(environment.requiredApprovals);
  }, [environment]);

  return (
    <tr>
      <td>
        <span className="pill">{environment.slug}</span>
      </td>
      <td>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />
          {required ? "enabled" : "disabled"}
        </label>
      </td>
      <td>
        <input
          className="role-select"
          type="number"
          min={1}
          max={10}
          value={count}
          disabled={!required}
          onChange={(event) => setCount(Math.max(1, Math.min(10, Number(event.target.value))))}
        />
      </td>
      <td className="right actions">
        <button
          className="small"
          onClick={() => onSave({ approvalRequired: required, requiredApprovals: count })}
        >
          save
        </button>
      </td>
    </tr>
  );
}
