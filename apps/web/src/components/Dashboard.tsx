import { useCallback, useEffect, useState } from "react";
import type { ProjectDto, UserDto } from "@opensiel/shared";
import { Diamond, FolderPlus, Loader2, LogOut, Plus } from "lucide-react";
import { api, errorMessage } from "../api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Notice } from "./Notice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { SecretsView } from "./SecretsView";
import { ScanView } from "./ScanView";
import { MembersView } from "./MembersView";
import { ApprovalsView } from "./ApprovalsView";
import { IdentitiesView } from "./IdentitiesView";
import { AuditView } from "./AuditView";
import { DynamicView } from "./DynamicView";

type Tab = "secrets" | "scan" | "dynamic" | "approvals" | "members" | "identities" | "audit";

const TABS: { value: Tab; label: string }[] = [
  { value: "secrets", label: "Secrets" },
  { value: "scan", label: "Scan" },
  { value: "dynamic", label: "Dynamic" },
  { value: "approvals", label: "Approvals" },
  { value: "members", label: "Members" },
  { value: "identities", label: "Identities" },
  { value: "audit", label: "Audit" },
];

export function Dashboard({ user, onSignedOut }: { user: UserDto; onSignedOut: () => void }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectId, setProjectId] = useState("");
  const [env, setEnv] = useState("dev");
  const [tab, setTab] = useState<Tab>("secrets");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [loading, setLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    try {
      const result = await api.get<{ projects: ProjectDto[] }>("/api/projects");
      setProjects(result.projects);
      setProjectId((current) => {
        if (current && result.projects.some((project) => project.id === current)) return current;
        return result.projects[0]?.id ?? "";
      });
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const project = projects.find((candidate) => candidate.id === projectId);
  const canManage = user.role === "owner" || user.role === "admin";

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
    <div className="grid min-h-full md:grid-cols-[264px_1fr]">
      <aside className="flex flex-col gap-6 border-b bg-sidebar p-5 md:border-r md:border-b-0">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Diamond className="size-5 text-primary" />
          opensiel
        </div>

        <div className="flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Projects
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="New project"
              onClick={() => setCreating((value) => !value)}
            >
              <Plus className="size-4" />
            </Button>
          </div>

          {creating && (
            <form className="flex gap-2" onSubmit={createProject}>
              <Input
                autoFocus
                placeholder="project name"
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                className="h-8"
              />
              <Button size="sm" type="submit">
                add
              </Button>
            </form>
          )}

          <nav className="space-y-1">
            {projects.map((candidate) => (
              <Button
                key={candidate.id}
                variant={candidate.id === projectId ? "secondary" : "ghost"}
                className={cn(
                  "h-auto w-full justify-between px-3 py-2 font-normal",
                  candidate.id === projectId && "font-medium",
                )}
                onClick={() => setProjectId(candidate.id)}
              >
                <span className="truncate">{candidate.name}</span>
                <span className="text-xs text-muted-foreground">
                  {candidate.environments.length}
                </span>
              </Button>
            ))}
            {projects.length === 0 && !loading && (
              <p className="px-3 text-sm text-muted-foreground">No projects yet.</p>
            )}
            {loading && (
              <p className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> loading…
              </p>
            )}
          </nav>
        </div>

        <div className="space-y-2 border-t pt-4">
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-0 py-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={signOut}
          >
            <LogOut className="size-3.5" /> sign out
          </Button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-col gap-6 p-6">
        {error && (
          <Notice tone="error" onDismiss={() => setError("")}>
            {error}
          </Notice>
        )}

        {!project ? (
          <div className="grid flex-1 place-items-center py-20 text-center">
            <div className="space-y-3">
              <FolderPlus className="mx-auto size-10 text-muted-foreground" />
              <h2 className="text-lg font-semibold">No project selected</h2>
              <p className="text-sm text-muted-foreground">
                Create a project to start storing secrets.
              </p>
            </div>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div className="space-y-1">
                <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
                <p className="text-sm text-muted-foreground">
                  {project.slug} · {project.environments.length} environments
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {project.environments
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((environment) => (
                    <Button
                      key={environment.id}
                      size="sm"
                      variant={environment.slug === env ? "default" : "outline"}
                      className="font-mono"
                      onClick={() => setEnv(environment.slug)}
                    >
                      {environment.slug}
                    </Button>
                  ))}
              </div>
            </header>

            <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
              <TabsList>
                {TABS.filter((entry) => entry.value !== "dynamic" || canManage).map((entry) => (
                  <TabsTrigger key={entry.value} value={entry.value}>
                    {entry.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="secrets">
                <SecretsView project={project} env={env} />
              </TabsContent>
              <TabsContent value="scan">
                <ScanView project={project} />
              </TabsContent>
              <TabsContent value="dynamic">
                <DynamicView project={project} canManage={canManage} />
              </TabsContent>
              <TabsContent value="approvals">
                <ApprovalsView
                  project={project}
                  currentUserId={user.id}
                  canApprove={canManage}
                />
              </TabsContent>
              <TabsContent value="members">
                <MembersView />
              </TabsContent>
              <TabsContent value="identities">
                <IdentitiesView project={project} />
              </TabsContent>
              <TabsContent value="audit">
                <AuditView project={project} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>
    </div>
  );
}
