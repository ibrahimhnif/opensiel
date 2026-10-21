import { useCallback, useEffect, useState } from "react";
import type { DynamicConfigDto, DynamicLeaseDto, ProjectDto } from "@opensiel/shared";
import { Copy, Database, KeyRound, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Pagination } from "./Pagination";
import { usePagination } from "../hooks/usePagination";
import { Textarea } from "./ui/textarea";
import { Notice } from "./Notice";

const DEFAULT_CREATION =
  "CREATE ROLE \"{{username}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expires}}'";
const DEFAULT_REVOCATION = 'DROP ROLE IF EXISTS "{{username}}"';

interface Credentials {
  configName: string;
  username: string;
  password: string;
  host: string;
  database: string;
  expiresAt: string;
}

export function DynamicView({ project }: { project: ProjectDto; canManage: boolean }) {
  const [configs, setConfigs] = useState<DynamicConfigDto[]>([]);
  const [leases, setLeases] = useState<DynamicLeaseDto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<Credentials | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [adminUrl, setAdminUrl] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState(3600);
  const [creationStatement, setCreationStatement] = useState(DEFAULT_CREATION);
  const [revocationStatement, setRevocationStatement] = useState(DEFAULT_REVOCATION);
  const [busy, setBusy] = useState(false);
  const [leasingConfig, setLeasingConfig] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [configResult, leaseResult] = await Promise.all([
        api.get<{ configurations: DynamicConfigDto[] }>(
          `/api/projects/${project.id}/dynamic-secrets`,
        ),
        api.get<{ leases: DynamicLeaseDto[] }>(
          `/api/projects/${project.id}/dynamic-secrets/leases`,
        ),
      ]);
      setConfigs(configResult.configurations);
      setLeases(leaseResult.leases);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const configPagination = usePagination(configs, {
    pageSize: 10,
    resetKey: project.id,
  });
  const leasePagination = usePagination(leases, {
    pageSize: 10,
    resetKey: project.id,
  });

  function openForm() {
    setOpen(true);
    setName("");
    setAdminUrl("");
    setTtlSeconds(3600);
    setCreationStatement(DEFAULT_CREATION);
    setRevocationStatement(DEFAULT_REVOCATION);
  }

  async function createConfig(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/projects/${project.id}/dynamic-secrets`, {
        name: name.trim(),
        adminUrl: adminUrl.trim(),
        ttlSeconds,
        creationStatement: creationStatement.trim() || undefined,
        revocationStatement: revocationStatement.trim() || undefined,
      });
      setOpen(false);
      setNotice(`configuration ${name} created`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createLease(config: DynamicConfigDto) {
    setLeasingConfig(config.id);
    setError("");
    try {
      const result = await api.post<{
        lease: DynamicLeaseDto;
        username: string;
        password: string;
        host: string;
        database: string;
      }>(`/api/projects/${project.id}/dynamic-secrets/${config.id}/leases`);
      setCreated({
        configName: config.name,
        username: result.username,
        password: result.password,
        host: result.host,
        database: result.database,
        expiresAt: result.lease.expiresAt,
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLeasingConfig(null);
    }
  }

  async function revoke(lease: DynamicLeaseDto) {
    if (!window.confirm(`Revoke ${lease.username}? The database role is dropped.`)) return;
    try {
      await api.post(`/api/projects/${project.id}/dynamic-secrets/leases/${lease.id}/revoke`);
      setNotice(`lease for ${lease.username} revoked`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeConfig(config: DynamicConfigDto) {
    if (
      !window.confirm(
        `Delete ${config.name}? Existing database roles are not dropped automatically.`,
      )
    )
      return;
    try {
      await api.del(`/api/projects/${project.id}/dynamic-secrets/${config.id}`);
      setNotice(`configuration ${config.name} deleted`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied`);
    } catch {
      setError("clipboard is not available");
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Dynamic secrets</h2>
          <p className="text-sm text-muted-foreground">
            Issue short-lived PostgreSQL roles from an admin connection string. Roles are dropped on
            revoke or when the lease expires.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" /> refresh
          </Button>
          <Button size="sm" onClick={openForm}>
            <Plus className="size-4" /> new configuration
          </Button>
        </div>
      </div>

      {notice && (
        <Notice tone="success" onDismiss={() => setNotice("")}>
          {notice}
        </Notice>
      )}
      {error && (
        <Notice tone="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}

      {created && (
        <div className="border-primary/40 bg-primary/10 text-primary rounded-lg border px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-3">
              <div className="flex items-center gap-2 font-medium">
                <KeyRound className="size-4" /> Credentials from {created.configName} — shown once
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <span className="opacity-80">host</span>
                  <div className="flex items-center gap-2">
                    <code className="bg-transparent p-0">{created.host}</code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => void copy(created.host, "host")}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div>
                  <span className="opacity-80">database</span>
                  <div className="flex items-center gap-2">
                    <code className="bg-transparent p-0">{created.database}</code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => void copy(created.database, "database")}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div>
                  <span className="opacity-80">username</span>
                  <div className="flex items-center gap-2">
                    <code className="bg-transparent p-0">{created.username}</code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => void copy(created.username, "username")}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div>
                  <span className="opacity-80">password</span>
                  <div className="flex items-center gap-2">
                    <code className="bg-transparent p-0 break-all">{created.password}</code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => void copy(created.password, "password")}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-xs opacity-80">Expires {formatDate(created.expiresAt)}</p>
            </div>
            <button onClick={() => setCreated(null)} aria-label="dismiss" className="opacity-70">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Configurations</h3>
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>TTL</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configPagination.pageItems.map((config) => (
                <TableRow key={config.id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Database className="size-4 text-primary" /> {config.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{config.provider}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTtl(config.ttlSeconds)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(config.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        disabled={leasingConfig === config.id}
                        onClick={() => void createLease(config)}
                      >
                        {leasingConfig === config.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <KeyRound className="size-3.5" />
                        )}
                        new lease
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void removeConfig(config)}
                      >
                        <Trash2 className="size-3.5" /> delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {configs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No dynamic secret configurations yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pagination
            page={configPagination.page}
            pageSize={configPagination.pageSize}
            total={configPagination.total}
            totalPages={configPagination.totalPages}
            rangeStart={configPagination.rangeStart}
            rangeEnd={configPagination.rangeEnd}
            onPageChange={configPagination.setPage}
            onPageSizeChange={configPagination.setPageSize}
          />
        </Card>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Leases</h3>
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Configuration</TableHead>
                <TableHead>Username</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leasePagination.pageItems.map((lease) => (
                <TableRow key={lease.id}>
                  <TableCell>{lease.configName}</TableCell>
                  <TableCell>
                    <code className="bg-transparent p-0 text-xs">{lease.username}</code>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {lease.createdByName}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(lease.expiresAt)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        lease.status === "active"
                          ? "success"
                          : lease.status === "revoked"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {lease.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={lease.status !== "active"}
                      onClick={() => void revoke(lease)}
                    >
                      revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {leases.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No leases yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pagination
            page={leasePagination.page}
            pageSize={leasePagination.pageSize}
            total={leasePagination.total}
            totalPages={leasePagination.totalPages}
            rangeStart={leasePagination.rangeStart}
            rangeEnd={leasePagination.rangeEnd}
            onPageChange={leasePagination.setPage}
            onPageSizeChange={leasePagination.setPageSize}
          />
        </Card>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <form className="space-y-4" onSubmit={createConfig}>
            <DialogHeader>
              <DialogTitle>New dynamic secret configuration</DialogTitle>
              <DialogDescription>
                The admin connection string is encrypted with the project key and never returned by
                the API.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="dynamic-name">Name</Label>
                <Input
                  id="dynamic-name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="app-postgres"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dynamic-ttl">Lease TTL (seconds)</Label>
                <Input
                  id="dynamic-ttl"
                  type="number"
                  min={60}
                  max={86400}
                  value={ttlSeconds}
                  onChange={(event) => setTtlSeconds(Number(event.target.value))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dynamic-admin-url">Admin connection string</Label>
              <Input
                id="dynamic-admin-url"
                type="password"
                value={adminUrl}
                onChange={(event) => setAdminUrl(event.target.value)}
                placeholder="postgres://user:password@host:5432/database"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dynamic-create">Creation statement</Label>
              <Textarea
                id="dynamic-create"
                rows={3}
                value={creationStatement}
                onChange={(event) => setCreationStatement(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Placeholders: {"{{username}}"}, {"{{password}}"}, {"{{expires}}"}.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dynamic-revoke">Revocation statement</Label>
              <Textarea
                id="dynamic-revoke"
                rows={2}
                value={revocationStatement}
                onChange={(event) => setRevocationStatement(event.target.value)}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? "saving…" : "create configuration"}
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

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
