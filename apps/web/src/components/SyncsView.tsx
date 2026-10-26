import { useEffect, useState } from "react";
import type { ProjectDto } from "@opensiel/shared";
import { Loader2, Play, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api, errorMessage } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Textarea } from "./ui/textarea";
import { Pagination } from "./Pagination";
import { useServerList } from "../hooks/useServerList";
import { notify } from "../lib/notify";
import { useToastMessage } from "../hooks/useToastMessage";
import { useConfirm } from "./ConfirmProvider";

interface Sync {
  id: string;
  environmentSlug: string;
  path: string;
  provider: string;
  enabled: boolean;
  intervalSeconds: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failureCount: number;
}

const PROVIDERS = [
  "webhook",
  "vercel",
  "cloudflare",
  "github",
  "aws",
  "gcp",
  "azure",
  "kubernetes",
] as const;

const CONFIG_TEMPLATES: Record<string, string> = {
  webhook: JSON.stringify({ url: "https://example.com/hook" }, null, 2),
  vercel: JSON.stringify({ token: "", vercelProjectId: "", target: ["production"] }, null, 2),
  cloudflare: JSON.stringify({ token: "", accountId: "", scriptName: "" }, null, 2),
  github: JSON.stringify({ token: "", owner: "", repo: "", environment: "" }, null, 2),
  aws: JSON.stringify({ region: "us-east-1", prefix: "" }, null, 2),
  gcp: JSON.stringify({ projectId: "", prefix: "" }, null, 2),
  azure: JSON.stringify({ vaultUrl: "", tenantId: "", clientId: "", clientSecret: "" }, null, 2),
  kubernetes: JSON.stringify(
    { apiUrl: "", token: "", namespace: "default", secretName: "" },
    null,
    2,
  ),
};

export function SyncsView({ project, canManage }: { project: ProjectDto; canManage: boolean }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useToastMessage("success", notice, setNotice);
  useToastMessage("error", error, setError);

  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string>("webhook");
  const [env, setEnv] = useState(project.environments[0]?.slug ?? "dev");
  const [path, setPath] = useState("/");
  const [intervalSeconds, setIntervalSeconds] = useState("300");
  const [configText, setConfigText] = useState(CONFIG_TEMPLATES.webhook);

  const list = useServerList<Sync>({
    key: project.id,
    pageSize: 10,
    initialSort: "createdAt",
    initialOrder: "desc",
    fetcher: async ({ limit, offset, q, sort, order }) => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        order,
      });
      if (q) params.set("q", q);
      if (sort) params.set("sort", sort);
      const result = await api.get<{ syncs: Sync[]; total: number }>(
        `/api/projects/${project.id}/syncs?${params}`,
      );
      return { items: result.syncs, total: result.total };
    },
  });

  useEffect(() => {
    if (list.error) notify.error(list.error);
  }, [list.error]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    let config: unknown;
    try {
      config = JSON.parse(configText);
    } catch {
      setError("config must be valid JSON");
      setBusy(false);
      return;
    }

    try {
      await api.post(`/api/projects/${project.id}/syncs`, {
        env,
        path: path.trim() || "/",
        provider,
        config,
        intervalSeconds: Number(intervalSeconds),
      });
      setOpen(false);
      setNotice("sync created");
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function run(sync: Sync) {
    setBusy(true);
    try {
      const result = await api.post<{ result: { status: string; count?: number; error?: string } }>(
        `/api/projects/${project.id}/syncs/${sync.id}/run`,
      );
      setNotice(
        result.result.status === "success"
          ? `synced ${result.result.count ?? 0} secret(s)`
          : `sync failed: ${result.result.error ?? "unknown error"}`,
      );
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(sync: Sync) {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${project.id}/syncs/${sync.id}`, {
        enabled: !sync.enabled,
      });
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(sync: Sync) {
    if (
      !(await confirm({
        title: "Delete sync?",
        description: `${sync.provider} → ${sync.environmentSlug}${sync.path === "/" ? "" : sync.path}`,
        confirmLabel: "delete",
        destructive: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.del(`/api/projects/${project.id}/syncs/${sync.id}`);
      setNotice("sync deleted");
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Secret syncs</h2>
          <p className="text-sm text-muted-foreground">
            Push an environment to a cloud provider, CI, or a webhook on a schedule.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              className="pl-8"
              placeholder="Search provider, env, path…"
              value={list.query}
              onChange={(event) => list.setQuery(event.target.value)}
            />
          </div>
          <Select value={list.sort || "createdAt"} onValueChange={list.setSort}>
            <SelectTrigger className="h-8 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt">created</SelectItem>
              <SelectItem value="provider">provider</SelectItem>
              <SelectItem value="environment">environment</SelectItem>
              <SelectItem value="nextRunAt">next run</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => list.setOrder(list.order === "asc" ? "desc" : "asc")}
          >
            {list.order}
          </Button>
          <Button variant="outline" size="sm" onClick={() => list.reload()} disabled={list.loading}>
            <RefreshCw className={list.loading ? "size-4 animate-spin" : "size-4"} />
            refresh
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-4" /> new sync
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="hidden md:table-cell">Schedule</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((sync) => (
              <TableRow key={sync.id}>
                <TableCell>
                  <Badge variant="outline">{sync.provider}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {sync.environmentSlug}
                  {sync.path !== "/" ? ` · ${sync.path}` : ""}
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  every {Math.round(sync.intervalSeconds / 60)}m ·{" "}
                  {sync.enabled ? formatDate(sync.nextRunAt) : "paused"}
                </TableCell>
                <TableCell>
                  {sync.lastStatus === "error" ? (
                    <div className="space-y-1">
                      <Badge variant="destructive">error</Badge>
                      <div className="max-w-40 truncate text-xs text-muted-foreground">
                        {sync.lastError}
                      </div>
                    </div>
                  ) : sync.lastStatus === "success" ? (
                    <Badge variant="success">ok</Badge>
                  ) : (
                    <Badge variant="outline">pending</Badge>
                  )}
                  {sync.failureCount > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {sync.failureCount} failure(s)
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canManage && (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run(sync)}
                      >
                        <Play className="size-3.5" /> run
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void toggle(sync)}
                      >
                        {sync.enabled ? "pause" : "resume"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => void remove(sync)}
                      >
                        <Trash2 className="size-3.5" /> delete
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {list.total === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  {list.query ? "No matching syncs." : "No syncs yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination {...list.pagination} />
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form className="space-y-4" onSubmit={create}>
            <DialogHeader>
              <DialogTitle>New sync</DialogTitle>
              <DialogDescription>
                Credentials are encrypted with the project key. Applied keys are upserted; local
                deletions do not remove remote copies.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select
                  value={provider}
                  onValueChange={(value) => {
                    setProvider(value);
                    setConfigText(CONFIG_TEMPLATES[value] ?? "{}");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((candidate) => (
                      <SelectItem key={candidate} value={candidate}>
                        {candidate}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Environment</Label>
                <Select value={env} onValueChange={setEnv}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {project.environments.map((environment) => (
                      <SelectItem key={environment.id} value={environment.slug}>
                        {environment.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sync-path">Folder path</Label>
                <Input
                  id="sync-path"
                  value={path}
                  placeholder="/"
                  onChange={(event) => setPath(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sync-interval">Interval (seconds)</Label>
                <Input
                  id="sync-interval"
                  type="number"
                  min={60}
                  value={intervalSeconds}
                  onChange={(event) => setIntervalSeconds(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sync-config">Provider config (JSON)</Label>
              <Textarea
                id="sync-config"
                rows={10}
                className="font-mono text-xs"
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                required
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
