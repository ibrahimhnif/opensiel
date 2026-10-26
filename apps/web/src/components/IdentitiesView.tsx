import { useEffect, useState } from "react";
import type { IdentityAuthMethodDto, IdentityDto, ProjectDto } from "@opensiel/shared";
import { Copy, KeyRound, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
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
import { Textarea } from "./ui/textarea";
import { Pagination } from "./Pagination";
import { useServerList } from "../hooks/useServerList";
import { notify } from "../lib/notify";
import { useToastMessage } from "../hooks/useToastMessage";
import { useConfirm } from "./ConfirmProvider";

interface CreatedIdentity {
  name: string;
  clientId: string;
  clientSecret: string;
}

export function IdentitiesView({ project }: { project: ProjectDto }) {
  const confirm = useConfirm();
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedIdentity | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"viewer" | "member">("viewer");
  const [envIds, setEnvIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [authIdentity, setAuthIdentity] = useState<IdentityDto | null>(null);
  const [authMethods, setAuthMethods] = useState<IdentityAuthMethodDto[]>([]);
  const [authType, setAuthType] = useState<"jwt" | "aws">("jwt");
  const [jwtIssuer, setJwtIssuer] = useState("");
  const [jwtAudience, setJwtAudience] = useState("");
  const [jwtJwks, setJwtJwks] = useState("");
  const [jwtSubjects, setJwtSubjects] = useState("");
  const [awsArns, setAwsArns] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  useToastMessage("success", notice, setNotice);
  useToastMessage("error", error, setError);

  const list = useServerList<IdentityDto>({
    key: project.id,
    pageSize: 10,
    initialSort: "createdAt",
    initialOrder: "asc",
    fetcher: async ({ limit, offset, q, sort, order }) => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        order,
      });
      if (q) params.set("q", q);
      if (sort) params.set("sort", sort);
      const result = await api.get<{ identities: IdentityDto[]; total: number }>(
        `/api/projects/${project.id}/identities?${params}`,
      );
      return { items: result.identities, total: result.total };
    },
  });

  useEffect(() => {
    if (list.error) notify.error(list.error);
  }, [list.error]);

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
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(identity: IdentityDto) {
    if (
      !(await confirm({
        title: `Revoke ${identity.name}?`,
        description: "New tokens stop being issued immediately; existing tokens are rejected.",
        confirmLabel: "revoke",
        destructive: true,
      }))
    )
      return;
    try {
      await api.post(`/api/projects/${project.id}/identities/${identity.id}/revoke`);
      setNotice(`${identity.name} revoked`);
      list.reload();
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

  async function openAuth(identity: IdentityDto) {
    setAuthIdentity(identity);
    setAuthMethods([]);
    try {
      const result = await api.get<{ methods: IdentityAuthMethodDto[] }>(
        `/api/projects/${project.id}/identities/${identity.id}/auth-methods`,
      );
      setAuthMethods(result.methods);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function refreshAuthMethods(identityId: string) {
    const result = await api.get<{ methods: IdentityAuthMethodDto[] }>(
      `/api/projects/${project.id}/identities/${identityId}/auth-methods`,
    );
    setAuthMethods(result.methods);
  }

  async function addAuthMethod(event: React.FormEvent) {
    event.preventDefault();
    if (!authIdentity) return;
    setAuthBusy(true);
    try {
      const payload =
        authType === "aws"
          ? {
              type: "aws",
              allowedArns: awsArns
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean),
            }
          : {
              type: "jwt",
              issuer: jwtIssuer.trim(),
              audience: jwtAudience.trim(),
              jwksUri: jwtJwks.trim(),
              allowedSubjects: jwtSubjects
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            };
      await api.post(
        `/api/projects/${project.id}/identities/${authIdentity.id}/auth-methods`,
        payload,
      );
      setNotice("auth method added");
      setJwtIssuer("");
      setJwtAudience("");
      setJwtJwks("");
      setJwtSubjects("");
      setAwsArns("");
      await refreshAuthMethods(authIdentity.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function removeAuthMethod(method: IdentityAuthMethodDto) {
    if (!authIdentity) return;
    if (
      !(await confirm({
        title: "Delete auth method?",
        description: "Clients using it can no longer exchange tokens.",
        confirmLabel: "delete",
        destructive: true,
      }))
    ) {
      return;
    }
    setAuthBusy(true);
    try {
      await api.del(
        `/api/projects/${project.id}/identities/${authIdentity.id}/auth-methods/${method.id}`,
      );
      setNotice("auth method deleted");
      await refreshAuthMethods(authIdentity.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAuthBusy(false);
    }
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
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              className="pl-8"
              placeholder="Search name, client id, role…"
              value={list.query}
              onChange={(event) => list.setQuery(event.target.value)}
            />
          </div>
          <Select value={list.sort || "createdAt"} onValueChange={(value) => list.setSort(value)}>
            <SelectTrigger className="h-8 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="createdAt">sort: created</SelectItem>
              <SelectItem value="name">sort: name</SelectItem>
              <SelectItem value="role">sort: role</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => list.setOrder(list.order === "asc" ? "desc" : "asc")}
          >
            {list.order}
          </Button>
          <Button variant="outline" size="sm" onClick={() => list.reload()}>
            <RefreshCw className="size-4" /> refresh
          </Button>
          <Button size="sm" onClick={openForm}>
            <Plus className="size-4" /> new identity
          </Button>
        </div>
      </div>

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
            {list.items.map((identity) => (
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
                    onClick={() => void openAuth(identity)}
                  >
                    <KeyRound className="size-3.5" /> auth
                  </Button>
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
            {list.total === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {list.query ? "No matching identities." : "No machine identities yet."}
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
              <DialogTitle>New machine identity</DialogTitle>
              <DialogDescription>The client secret is shown once after creation.</DialogDescription>
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
              <Select value={role} onValueChange={(value) => setRole(value as "viewer" | "member")}>
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
      <Dialog
        open={Boolean(authIdentity)}
        onOpenChange={(next) => {
          if (!next) setAuthIdentity(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trusted authentication · {authIdentity?.name ?? ""}</DialogTitle>
            <DialogDescription>
              Exchange a trusted JWT or an AWS signed request for a machine token.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {authMethods.length === 0 && (
              <p className="text-sm text-muted-foreground">No auth methods yet.</p>
            )}
            {authMethods.map((method) => (
              <div
                key={method.id}
                className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0 space-y-1">
                  <Badge variant="outline">{method.type}</Badge>
                  <p className="truncate text-xs text-muted-foreground">
                    {method.type === "aws"
                      ? (method.allowedArns ?? []).join(", ")
                      : `${method.issuer} · ${method.audience}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={authBusy}
                  onClick={() => void removeAuthMethod(method)}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <form className="space-y-3" onSubmit={addAuthMethod}>
            <div className="space-y-2">
              <Label>Method</Label>
              <Select
                value={authType}
                onValueChange={(value) => setAuthType(value as "jwt" | "aws")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jwt">jwt (OIDC / Kubernetes)</SelectItem>
                  <SelectItem value="aws">aws (SigV4)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {authType === "jwt" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="auth-issuer">Issuer</Label>
                    <Input
                      id="auth-issuer"
                      value={jwtIssuer}
                      placeholder="https://kubernetes.default.svc"
                      onChange={(event) => setJwtIssuer(event.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="auth-audience">Audience</Label>
                    <Input
                      id="auth-audience"
                      value={jwtAudience}
                      placeholder="opensiel"
                      onChange={(event) => setJwtAudience(event.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="auth-jwks">JWKS URL</Label>
                  <Input
                    id="auth-jwks"
                    value={jwtJwks}
                    placeholder="https://issuer/openid/v1/jwks"
                    onChange={(event) => setJwtJwks(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="auth-subjects">
                    Allowed subjects{" "}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="auth-subjects"
                    value={jwtSubjects}
                    placeholder="system:serviceaccount:apps:web"
                    onChange={(event) => setJwtSubjects(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="auth-arns">Allowed ARNs (one per line)</Label>
                <Textarea
                  id="auth-arns"
                  rows={4}
                  value={awsArns}
                  placeholder="arn:aws:iam::123456789012:role/ci-deploy"
                  onChange={(event) => setAwsArns(event.target.value)}
                  required
                />
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAuthIdentity(null)}>
                close
              </Button>
              <Button type="submit" disabled={authBusy}>
                {authBusy && <Loader2 className="size-4 animate-spin" />}
                add method
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
