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
import { Pagination } from "./Pagination";
import { useServerList } from "../hooks/useServerList";
import { notify } from "../lib/notify";
import { useToastMessage } from "../hooks/useToastMessage";
import { useConfirm } from "./ConfirmProvider";

interface Rotation {
  id: string;
  key: string;
  path: string;
  environmentSlug: string;
  provider: string;
  intervalSeconds: number;
  graceSeconds: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failureCount: number;
  previousRevokeAfter: string | null;
  createdAt: string;
}

interface FormState {
  key: string;
  env: string;
  path: string;
  provider: "postgres" | "http";
  adminUrl: string;
  username: string;
  alternateUsername: string;
  createUrl: string;
  revokeUrl: string;
  valueTemplate: string;
  intervalDays: string;
  graceMinutes: string;
}

function emptyForm(env: string): FormState {
  return {
    key: "",
    env,
    path: "/",
    provider: "http",
    adminUrl: "",
    username: "",
    alternateUsername: "",
    createUrl: "",
    revokeUrl: "",
    valueTemplate: "",
    intervalDays: "30",
    graceMinutes: "60",
  };
}

export function RotationsView({ project, canManage }: { project: ProjectDto; canManage: boolean }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(() =>
    emptyForm(project.environments[0]?.slug ?? "dev"),
  );
  useToastMessage("success", notice, setNotice);
  useToastMessage("error", error, setError);

  const list = useServerList<Rotation>({
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
      const result = await api.get<{ rotations: Rotation[]; total: number }>(
        `/api/projects/${project.id}/rotations?${params}`,
      );
      return { items: result.rotations, total: result.total };
    },
  });

  useEffect(() => {
    if (list.error) notify.error(list.error);
  }, [list.error]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const intervalSeconds = Number(form.intervalDays) * 86_400;
    const graceSeconds = Number(form.graceMinutes) * 60;
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= graceSeconds) {
      setError("the interval must be longer than the grace window");
      setBusy(false);
      return;
    }

    const config =
      form.provider === "postgres"
        ? {
            adminUrl: form.adminUrl,
            username: form.username,
            alternateUsername: form.alternateUsername,
            valueTemplate: form.valueTemplate || "{{username}}:{{password}}",
          }
        : {
            createUrl: form.createUrl,
            revokeUrl: form.revokeUrl || undefined,
            valueTemplate: form.valueTemplate || undefined,
          };

    try {
      await api.post(`/api/projects/${project.id}/rotations`, {
        key: form.key.trim(),
        env: form.env,
        path: form.path.trim() || "/",
        provider: form.provider,
        config,
        intervalSeconds,
        graceSeconds,
      });
      setOpen(false);
      setForm(emptyForm(form.env));
      setNotice("rotation policy created");
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rotation: Rotation) {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${project.id}/rotations/${rotation.id}`, {
        enabled: !rotation.enabled,
      });
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate(rotation: Rotation) {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ result: { status: string; error?: string } }>(
        `/api/projects/${project.id}/rotations/${rotation.id}/rotate`,
      );
      setNotice(
        result.result.status === "success"
          ? `rotated ${rotation.key}`
          : `rotation failed: ${result.result.error ?? "unknown error"}`,
      );
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(rotation: Rotation) {
    if (
      !(await confirm({
        title: "Delete rotation policy",
        description: `Stop rotating ${rotation.key}?`,
        confirmLabel: "delete",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.del(`/api/projects/${project.id}/rotations/${rotation.id}`);
      setNotice(`deleted rotation for ${rotation.key}`);
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
          <h2 className="text-lg font-semibold">Secret rotation</h2>
          <p className="text-sm text-muted-foreground">
            Rotate static credentials with a grace window before the old one is revoked.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              className="pl-8"
              placeholder="Search key, provider, env…"
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
              <SelectItem value="key">key</SelectItem>
              <SelectItem value="provider">provider</SelectItem>
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
              <Plus className="size-4" /> new rotation
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Secret</TableHead>
              <TableHead className="hidden sm:table-cell">Provider</TableHead>
              <TableHead className="hidden md:table-cell">Interval</TableHead>
              <TableHead className="hidden md:table-cell">Next run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((rotation) => (
              <TableRow key={rotation.id}>
                <TableCell className="whitespace-normal">
                  <code className="bg-transparent p-0 text-sm">{rotation.key}</code>
                  <div className="text-xs text-muted-foreground">
                    {rotation.environmentSlug}
                    {rotation.path !== "/" ? ` · ${rotation.path}` : ""}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Badge variant="outline">{rotation.provider}</Badge>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  every {Math.round(rotation.intervalSeconds / 3600)}h · grace{" "}
                  {Math.round(rotation.graceSeconds / 60)}m
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  {rotation.enabled ? formatDate(rotation.nextRunAt) : "paused"}
                  {rotation.previousRevokeAfter && (
                    <div>old credential until {formatDate(rotation.previousRevokeAfter)}</div>
                  )}
                </TableCell>
                <TableCell>
                  {rotation.lastStatus === "error" ? (
                    <div className="space-y-1">
                      <Badge variant="destructive">error</Badge>
                      <div className="max-w-40 truncate text-xs text-muted-foreground">
                        {rotation.lastError}
                      </div>
                    </div>
                  ) : rotation.lastStatus === "success" ? (
                    <Badge variant="success">ok</Badge>
                  ) : (
                    <Badge variant="outline">pending</Badge>
                  )}
                  {rotation.failureCount > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {rotation.failureCount} failure(s)
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canManage && (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void rotate(rotation)}
                        disabled={busy}
                      >
                        <Play className="size-3.5" /> rotate
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void toggle(rotation)}
                        disabled={busy}
                      >
                        {rotation.enabled ? "pause" : "resume"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void remove(rotation)}
                        disabled={busy}
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
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  {list.query ? "No matching rotation policies." : "No rotation policies yet."}
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
              <DialogTitle>New rotation policy</DialogTitle>
              <DialogDescription>
                The new credential is written as a new secret version; the previous one is revoked
                after the grace window.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="rotation-key">Secret key</Label>
                <Input
                  id="rotation-key"
                  value={form.key}
                  placeholder="DATABASE_URL"
                  onChange={(event) => setForm({ ...form, key: event.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Environment</Label>
                <Select
                  value={form.env}
                  onValueChange={(value) => setForm({ ...form, env: value })}
                >
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
                <Label htmlFor="rotation-path">Folder path</Label>
                <Input
                  id="rotation-path"
                  value={form.path}
                  placeholder="/"
                  onChange={(event) => setForm({ ...form, path: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select
                  value={form.provider}
                  onValueChange={(value) =>
                    setForm({ ...form, provider: value as "postgres" | "http" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">http</SelectItem>
                    <SelectItem value="postgres">postgres</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.provider === "postgres" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="rotation-admin-url">Admin connection URL</Label>
                  <Input
                    id="rotation-admin-url"
                    value={form.adminUrl}
                    placeholder="postgres://admin:…@host:5432/db"
                    onChange={(event) => setForm({ ...form, adminUrl: event.target.value })}
                    required
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="rotation-user">Role name</Label>
                    <Input
                      id="rotation-user"
                      value={form.username}
                      placeholder="app_user_a"
                      onChange={(event) => setForm({ ...form, username: event.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rotation-alt-user">Alternate role</Label>
                    <Input
                      id="rotation-alt-user"
                      value={form.alternateUsername}
                      placeholder="app_user_b"
                      onChange={(event) =>
                        setForm({ ...form, alternateUsername: event.target.value })
                      }
                      required
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="rotation-create-url">Create URL</Label>
                  <Input
                    id="rotation-create-url"
                    value={form.createUrl}
                    placeholder="https://rotator.example.com/create"
                    onChange={(event) => setForm({ ...form, createUrl: event.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rotation-revoke-url">
                    Revoke URL <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="rotation-revoke-url"
                    value={form.revokeUrl}
                    placeholder="https://rotator.example.com/revoke"
                    onChange={(event) => setForm({ ...form, revokeUrl: event.target.value })}
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="rotation-template">
                Value template <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="rotation-template"
                value={form.valueTemplate}
                placeholder="{{username}}:{{password}}"
                onChange={(event) => setForm({ ...form, valueTemplate: event.target.value })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="rotation-interval">Interval (days)</Label>
                <Input
                  id="rotation-interval"
                  type="number"
                  min={1}
                  value={form.intervalDays}
                  onChange={(event) => setForm({ ...form, intervalDays: event.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rotation-grace">Grace (minutes)</Label>
                <Input
                  id="rotation-grace"
                  type="number"
                  min={0}
                  value={form.graceMinutes}
                  onChange={(event) => setForm({ ...form, graceMinutes: event.target.value })}
                  required
                />
              </div>
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
