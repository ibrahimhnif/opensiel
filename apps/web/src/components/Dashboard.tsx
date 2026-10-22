import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ProjectDto, UserDto } from "@opensiel/shared";
import { FolderPlus, Loader2, LogOut, Plus } from "lucide-react";
import { api, errorMessage } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useToastMessage } from "../hooks/useToastMessage";
import { Logo } from "./Logo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { SecretsView } from "./SecretsView";
import { ScanView } from "./ScanView";
import { MembersView } from "./MembersView";
import { ApprovalsView } from "./ApprovalsView";
import { IdentitiesView } from "./IdentitiesView";
import { AuditView } from "./AuditView";
import { DynamicView } from "./DynamicView";
import { WebhooksView } from "./WebhooksView";
import { MfaCard } from "./MfaCard";
import { RotationsView } from "./RotationsView";
import { RolesView } from "./RolesView";

type Tab =
  | "secrets"
  | "scan"
  | "dynamic"
  | "webhooks"
  | "approvals"
  | "members"
  | "identities"
  | "audit"
  | "security"
  | "rotations"
  | "access";

const TABS: { value: Tab; label: string }[] = [
  { value: "secrets", label: "Secrets" },
  { value: "scan", label: "Scan" },
  { value: "dynamic", label: "Dynamic" },
  { value: "webhooks", label: "Webhooks" },
  { value: "approvals", label: "Approvals" },
  { value: "members", label: "Members" },
  { value: "identities", label: "Identities" },
  { value: "audit", label: "Audit" },
  { value: "rotations", label: "Rotations" },
  { value: "access", label: "Access" },
  { value: "security", label: "Security" },
];

export function Dashboard({ user, onSignedOut }: { user: UserDto; onSignedOut: () => void }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("secrets");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [loading, setLoading] = useState(true);
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);
  useToastMessage("error", error, setError);

  const loadProjects = useCallback(async () => {
    try {
      const result = await api.get<{ projects: ProjectDto[] }>("/api/projects");
      setProjects(result.projects);
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

  const projectIdParam = searchParams.get("project") ?? "";
  const envParam = searchParams.get("env") ?? "";
  const project = projects.find((candidate) => candidate.id === projectIdParam) ?? projects[0];
  const projectId = project?.id ?? "";
  const env = project?.environments.some((candidate) => candidate.slug === envParam)
    ? envParam
    : (project?.environments[0]?.slug ?? "dev");
  const canManage = user.role === "owner" || user.role === "admin";

  useEffect(() => {
    if (!project) return;
    const next = new URLSearchParams(searchParams);
    let changed = false;
    if (next.get("project") !== project.id) {
      next.set("project", project.id);
      changed = true;
    }
    if (next.get("env") !== env) {
      next.set("env", env);
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [project, env, searchParams, setSearchParams]);

  function selectProject(id: string) {
    const target = projects.find((candidate) => candidate.id === id);
    const next = new URLSearchParams(searchParams);
    next.set("project", id);
    next.set(
      "env",
      target?.environments.some((candidate) => candidate.slug === envParam)
        ? envParam
        : (target?.environments[0]?.slug ?? "dev"),
    );
    setSearchParams(next);
  }

  function selectEnv(slug: string) {
    const next = new URLSearchParams(searchParams);
    next.set("project", projectId);
    next.set("env", slug);
    setSearchParams(next);
  }

  async function createProject(event: React.FormEvent): Promise<boolean> {
    event.preventDefault();
    if (!newProjectName.trim()) return false;
    try {
      const result = await api.post<{ project: ProjectDto }>("/api/projects", {
        name: newProjectName.trim(),
      });
      setNewProjectName("");
      setCreating(false);
      await loadProjects();
      setSearchParams({
        project: result.project.id,
        env: result.project.environments[0]?.slug ?? "dev",
      });
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
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
      <aside className="hidden flex-col gap-6 border-r bg-sidebar p-5 md:flex">
        <div className="flex items-center justify-between">
          <Logo />
          <Badge variant="outline" className="text-[10px]">
            v0.1.0
          </Badge>
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
                onClick={() => selectProject(candidate.id)}
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

      <main className="flex min-w-0 flex-col gap-6 p-4 md:p-6">
        <div className="space-y-3 md:hidden">
          <div className="flex items-center justify-between">
            <Logo />
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {projects.length > 0 ? (
              <Select value={projectId} onValueChange={selectProject}>
                <SelectTrigger className="h-9 flex-1">
                  <SelectValue placeholder="Project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="flex-1 text-sm text-muted-foreground">No projects yet</span>
            )}
            <Button
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              onClick={() => setMobileCreateOpen(true)}
              aria-label="new project"
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>

        {loading && projects.length === 0 ? (
          <div className="grid flex-1 place-items-center py-16">
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> loading projects…
            </span>
          </div>
        ) : !project ? (
          <div className="grid flex-1 place-items-center py-16">
            <div className="w-full max-w-md space-y-5 rounded-xl border bg-card p-6 text-center">
              <FolderPlus className="mx-auto size-10 text-primary" />
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">Create your first project</h2>
                <p className="text-sm text-muted-foreground">
                  Projects group secrets by environment. You can add more later.
                </p>
              </div>
              <form className="flex gap-2" onSubmit={createProject}>
                <Input
                  autoFocus
                  placeholder="my-app"
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.target.value)}
                  required
                />
                <Button type="submit">
                  <Plus className="size-4" /> create
                </Button>
              </form>
              <div className="grid gap-2 text-left text-xs text-muted-foreground">
                <p>1. Create a project and its environments.</p>
                <p>2. Add secrets or import an existing .env file.</p>
                <p>
                  3. Run <code>opensiel run --env dev -- npm run dev</code>.
                </p>
              </div>
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
                      onClick={() => selectEnv(environment.slug)}
                    >
                      {environment.slug}
                    </Button>
                  ))}
              </div>
            </header>

            <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
              <TabsList className="w-full max-w-full justify-start overflow-x-auto md:w-fit">
                {TABS.filter(
                  (entry) =>
                    (entry.value !== "dynamic" &&
                      entry.value !== "webhooks" &&
                      entry.value !== "rotations" &&
                      entry.value !== "access") ||
                    canManage,
                ).map((entry) => (
                  <TabsTrigger key={entry.value} value={entry.value} className="shrink-0">
                    {entry.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="secrets">
                <SecretsView project={project} env={env} canManage={canManage} />
              </TabsContent>
              <TabsContent value="scan">
                <ScanView project={project} />
              </TabsContent>
              <TabsContent value="dynamic">
                <DynamicView project={project} canManage={canManage} />
              </TabsContent>
              <TabsContent value="webhooks">
                <WebhooksView project={project} />
              </TabsContent>
              <TabsContent value="approvals">
                <ApprovalsView
                  project={project}
                  currentUserId={user.id}
                  canApprove={canManage}
                  onRefresh={loadProjects}
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
              <TabsContent value="rotations">
                <RotationsView project={project} canManage={canManage} />
              </TabsContent>
              <TabsContent value="access">
                <RolesView project={project} />
              </TabsContent>
              <TabsContent value="security">
                <MfaCard isOwner={user.role === "owner"} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>

      <Dialog open={mobileCreateOpen} onOpenChange={setMobileCreateOpen}>
        <DialogContent className="max-w-sm">
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              if (await createProject(event)) setMobileCreateOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>Projects group secrets by environment.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="mobile-project-name">Name</Label>
              <Input
                id="mobile-project-name"
                autoFocus
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="my-app"
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMobileCreateOpen(false)}>
                cancel
              </Button>
              <Button type="submit">
                <Plus className="size-4" /> create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
