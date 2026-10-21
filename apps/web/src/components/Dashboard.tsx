import { useCallback, useEffect, useState } from "react";
import type { ProjectDto, UserDto } from "@opensiel/shared";
import { api, errorMessage } from "../api";
import { SecretsView } from "./SecretsView";
import { MembersView } from "./MembersView";
import { ApprovalsView } from "./ApprovalsView";
import { IdentitiesView } from "./IdentitiesView";
import { AuditView } from "./AuditView";

type Tab = "secrets" | "approvals" | "members" | "identities" | "audit";

export function Dashboard({ user, onSignedOut }: { user: UserDto; onSignedOut: () => void }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState("");
  const [env, setEnv] = useState("dev");
  const [tab, setTab] = useState<Tab>("secrets");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const loadProjects = useCallback(async () => {
    try {
      const result = await api.get<{ projects: ProjectDto[] }>("/api/projects");
      setProjects(result.projects);
      setProjectId((current) => {
        if (current && result.projects.some((project) => project.id === current)) return current;
        return result.projects[0]?.id ?? "";
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const project = projects.find((candidate) => candidate.id === projectId);

  useEffect(() => {
    if (!project) return;
    if (!project.environments.some((candidate) => candidate.slug === env)) {
      setEnv(project.environments[0]?.slug ?? "dev");
    }
  }, [project, env]);

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    if (!newProjectName.trim()) return;
    try {
      const result = await api.post<{ project: ProjectDto }>("/api/projects", {
        name: newProjectName.trim(),
      });
      setNewProjectName("");
      setCreating(false);
      await loadProjects();
      setProjectId(result.project.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function signOut() {
    try {
      await api.post("/api/auth/logout");
    } finally {
      onSignedOut();
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◈</span> opensiel
        </div>

        <div className="sidebar-section">
          <div className="sidebar-heading">
            Projects
            <button className="icon" title="New project" onClick={() => setCreating((value) => !value)}>
              +
            </button>
          </div>

          {creating && (
            <form className="inline-form" onSubmit={createProject}>
              <input
                autoFocus
                placeholder="project name"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
              />
              <button className="small primary" type="submit">
                add
              </button>
            </form>
          )}

          <nav className="project-list">
            {projects.map((candidate) => (
              <button
                key={candidate.id}
                className={`project ${candidate.id === projectId ? "active" : ""}`}
                onClick={() => setProjectId(candidate.id)}
              >
                <span>{candidate.name}</span>
                <span className="muted small">{candidate.environments.length} env</span>
              </button>
            ))}
            {projects.length === 0 && <p className="muted small">No projects yet.</p>}
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="muted small">{user.email}</div>
          <button className="link" onClick={signOut}>
            sign out
          </button>
        </div>
      </aside>

      <main className="main">
        {error && (
          <div className="banner error-banner">
            {error}
            <button className="link" onClick={() => setError("")}>
              dismiss
            </button>
          </div>
        )}

        {!project ? (
          <div className="empty">
            <h2>No project selected</h2>
            <p className="muted">Create a project to start storing secrets.</p>
          </div>
        ) : (
          <>
            <header className="topbar">
              <div>
                <h1>{project.name}</h1>
                <p className="muted small">
                  {project.slug} · {project.environments.length} environments
                </p>
              </div>
              <div className="env-tabs">
                {project.environments
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((environment) => (
                    <button
                      key={environment.id}
                      className={`env ${environment.slug === env ? "active" : ""}`}
                      onClick={() => setEnv(environment.slug)}
                    >
                      {environment.slug}
                    </button>
                  ))}
              </div>
            </header>

            <div className="tabs">
              {(["secrets", "approvals", "members", "identities", "audit"] as Tab[]).map((candidate) => (
                <button
                  key={candidate}
                  className={`tab ${tab === candidate ? "active" : ""}`}
                  onClick={() => setTab(candidate)}
                >
                  {candidate}
                </button>
              ))}
            </div>

            {tab === "secrets" && <SecretsView project={project} env={env} />}
            {tab === "approvals" && (
              <ApprovalsView
                project={project}
                currentUserId={user.id}
                canApprove={user.role === "owner" || user.role === "admin"}
              />
            )}
            {tab === "members" && <MembersView />}
            {tab === "identities" && <IdentitiesView project={project} />}
            {tab === "audit" && <AuditView project={project} />}
          </>
        )}
      </main>
    </div>
  );
}
