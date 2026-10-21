import { useCallback, useEffect, useState } from "react";
import type { IdentityDto, ProjectDto } from "@opensiel/shared";
import { Copy, KeyRound, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { api, errorMessage } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
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
import { Notice } from "./Notice";

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
  const [notice, setNotice] = useState("");

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
    if (
      !window.confirm(
        `Revoke ${identity.name}? Existing tokens stay valid until they expire (15 min).`,
      )
    )
      return;
    try {
      await api.post(`/api/projects/${project.id}/identities/${identity.id}/revoke`);
      setNotice(`${identity.name} revoked`);
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

  function envName(id: string): string {
    return project.environments.find((environment) => environment.id === id)?.slug ?? id;
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Machine identities</h2>
          <p className="text-sm text-muted-foreground">
            Client credentials for CI, servers, and local tooling.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" /> refresh
          </Button>
          <Button size="sm" onClick={openForm}>
            <Plus className="size-4" /> new identity
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
                <KeyRound className="size-4" /> Save this secret now — it is shown once.
              </div>
              <div className="space-y-1">
                <span className="text-xs opacity-80">client id</span>
                <div className="flex items-center gap-2">
                  <code className="block break-all bg-transparent p-0 text-xs">
                    {created.clientId}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => void copy(created.clientId, "client id")}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs opacity-80">client secret</span>
                <div className="flex items-center gap-2">
                  <code className="block break-all bg-transparent p-0 text-xs">
                    {created.clientSecret}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => void copy(created.clientSecret, "client secret")}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
            <button onClick={() => setCreated(null)} aria-label="dismiss" className="opacity-70">
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Environments</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((identity) => (
              <TableRow key={identity.id}>
                <TableCell>{identity.name}</TableCell>
                <TableCell>
                  <code className="bg-transparent p-0 text-xs">{identity.clientId}</code>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{identity.role}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {identity.environmentIds.map(envName).join(", ") || "—"}
                </TableCell>
                <TableCell>
                  {identity.revokedAt ? (
                    <Badge variant="destructive">revoked</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(identity.revokedAt)}
                    className={cn("text-destructive hover:text-destructive")}
                    onClick={() => void revoke(identity)}
                  >
                    revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No machine identities yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form className="space-y-4" onSubmit={create}>
            <DialogHeader>
              <DialogTitle>New machine identity</DialogTitle>
              <DialogDescription>
                The client secret is shown once after creation.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="identity-name">Name</Label>
              <Input
                id="identity-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="github-actions"
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={role}
                onValueChange={(value) => setRole(value as "viewer" | "member")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">viewer — read secrets</SelectItem>
                  <SelectItem value="member">member — read and write secrets</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Environments</Label>
              <div className="flex flex-wrap gap-4 rounded-lg border px-3 py-3">
                {project.environments.map((environment) => (
                  <label
                    key={environment.id}
                    className="flex items-center gap-2 text-sm capitalize"
                  >
                    <Checkbox
                      checked={envIds.includes(environment.id)}
                      onCheckedChange={() => toggleEnv(environment.id)}
                    />
                    {environment.slug}
                  </label>
                ))}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                cancel
              </Button>
              <Button type="submit" disabled={busy || envIds.length === 0}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? "creating…" : "create identity"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
