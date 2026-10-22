import { useCallback, useEffect, useState } from "react";
import type { ProjectDto } from "@opensiel/shared";
import { grantablePermissions } from "@opensiel/shared";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, errorMessage } from "../api";
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
import { useToastMessage } from "../hooks/useToastMessage";
import { useConfirm } from "./ConfirmProvider";

interface CustomRole {
  id: string;
  name: string;
  permissions: string[];
  createdAt: string;
}

interface Grant {
  id: string;
  userId: string;
  userName: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  projectId: string | null;
  environmentId: string | null;
  path: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
}

export function RolesView({ project }: { project: ProjectDto }) {
  const confirm = useConfirm();
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [roleOpen, setRoleOpen] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantUser, setGrantUser] = useState("");
  const [grantRole, setGrantRole] = useState("");
  const [grantScope, setGrantScope] = useState<"project" | "environment" | "path">("environment");
  const [grantEnv, setGrantEnv] = useState(project.environments[0]?.slug ?? "dev");
  const [grantPath, setGrantPath] = useState("/");
  const [grantExpires, setGrantExpires] = useState("");
  useToastMessage("success", notice, setNotice);
  useToastMessage("error", error, setError);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roleResult, grantResult, orgResult] = await Promise.all([
        api.get<{ roles: CustomRole[] }>("/api/org/roles"),
        api.get<{ grants: Grant[] }>("/api/org/grants"),
        api.get<{ members: Member[] }>("/api/org"),
      ]);
      setRoles(roleResult.roles);
      setGrants(grantResult.grants);
      setMembers(orgResult.members);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function togglePermission(permission: string, checked: boolean) {
    setPermissions((current) =>
      checked
        ? [...new Set([...current, permission])]
        : current.filter((item) => item !== permission),
    );
  }

  async function createRole(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/org/roles", { name: roleName.trim(), permissions });
      setRoleOpen(false);
      setRoleName("");
      setPermissions([]);
      setNotice("role created");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRole(role: CustomRole) {
    if (
      !(await confirm({
        title: `Delete role ${role.name}?`,
        description: "Grants using this role are removed.",
        confirmLabel: "delete",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.del(`/api/org/roles/${role.id}`);
      setNotice(`deleted role ${role.name}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createGrant(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const environmentId = project.environments.find(
      (environment) => environment.slug === grantEnv,
    )?.id;
    const body: Record<string, unknown> = {
      userId: grantUser,
      roleId: grantRole,
    };
    if (grantScope === "project") body.projectId = project.id;
    if (grantScope !== "project") body.environmentId = environmentId;
    if (grantScope === "path") body.path = grantPath.trim() || "/";
    if (grantExpires) {
      const expiresAt = new Date(grantExpires);
      if (Number.isNaN(expiresAt.getTime())) {
        setError("invalid expiry");
        setBusy(false);
        return;
      }
      body.expiresAt = expiresAt.toISOString();
    }

    try {
      await api.post("/api/org/grants", body);
      setGrantOpen(false);
      setGrantUser("");
      setGrantRole("");
      setGrantExpires("");
      setNotice("grant created");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeGrant(grant: Grant) {
    if (
      !(await confirm({
        title: `Revoke ${grant.roleName}?`,
        description: `Remove this grant from ${grant.userName}.`,
        confirmLabel: "revoke",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api.del(`/api/org/grants/${grant.id}`);
      setNotice("grant revoked");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function scopeLabel(grant: Grant): string {
    if (!grant.environmentId) return grant.projectId ? "project" : "organization";
    const environment = project.environments.find(
      (candidate) => candidate.id === grant.environmentId,
    );
    const slug = environment?.slug ?? "environment";
    return grant.path ? `${slug}:${grant.path}` : slug;
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Access control</h2>
          <p className="text-sm text-muted-foreground">
            Custom roles grant extra permissions scoped to a project, environment, or path.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            refresh
          </Button>
          <Button size="sm" onClick={() => setRoleOpen(true)}>
            <Plus className="size-4" /> new role
          </Button>
          <Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}>
            <Plus className="size-4" /> new grant
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
                <TableCell className="font-medium">{role.name}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {role.permissions.map((permission) => (
                      <Badge key={permission} variant="outline">
                        {permission}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void deleteRole(role)}
                    disabled={busy}
                  >
                    <Trash2 className="size-3.5" /> delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {roles.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                  No custom roles yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Scope</TableHead>
              <TableHead className="hidden md:table-cell">Expires</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.map((grant) => (
              <TableRow key={grant.id}>
                <TableCell>{grant.userName}</TableCell>
                <TableCell>
                  <Badge variant="outline">{grant.roleName}</Badge>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                  {scopeLabel(grant)}
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                  {grant.expiresAt ? formatDate(grant.expiresAt) : "never"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void revokeGrant(grant)}
                    disabled={busy}
                  >
                    revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {grants.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  No grants yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={roleOpen} onOpenChange={setRoleOpen}>
        <DialogContent>
          <form className="space-y-4" onSubmit={createRole}>
            <DialogHeader>
              <DialogTitle>New custom role</DialogTitle>
              <DialogDescription>
                Pick the permissions this role can grant within a scope.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                value={roleName}
                placeholder="dev-writer"
                onChange={(event) => setRoleName(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Permissions</Label>
              <div className="grid grid-cols-2 gap-2">
                {grantablePermissions.map((permission) => (
                  <label
                    key={permission}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-sm"
                  >
                    <Checkbox
                      checked={permissions.includes(permission)}
                      onCheckedChange={(checked) => togglePermission(permission, checked === true)}
                    />
                    <span className="font-mono text-xs">{permission}</span>
                  </label>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRoleOpen(false)}>
                cancel
              </Button>
              <Button type="submit" disabled={busy || permissions.length === 0}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
        <DialogContent>
          <form className="space-y-4" onSubmit={createGrant}>
            <DialogHeader>
              <DialogTitle>New grant</DialogTitle>
              <DialogDescription>
                Attach a custom role to a member for a project, environment, or path.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Member</Label>
                <Select value={grantUser} onValueChange={setGrantUser}>
                  <SelectTrigger>
                    <SelectValue placeholder="select member" />
                  </SelectTrigger>
                  <SelectContent>
                    {members.map((member) => (
                      <SelectItem key={member.userId} value={member.userId}>
                        {member.name} ({member.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={grantRole} onValueChange={setGrantRole}>
                  <SelectTrigger>
                    <SelectValue placeholder="select role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Scope</Label>
                <Select
                  value={grantScope}
                  onValueChange={(value) =>
                    setGrantScope(value as "project" | "environment" | "path")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">whole project</SelectItem>
                    <SelectItem value="environment">environment</SelectItem>
                    <SelectItem value="path">environment + path</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {grantScope !== "project" && (
                <div className="space-y-2">
                  <Label>Environment</Label>
                  <Select value={grantEnv} onValueChange={setGrantEnv}>
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
              )}
              {grantScope === "path" && (
                <div className="space-y-2">
                  <Label htmlFor="grant-path">Path</Label>
                  <Input
                    id="grant-path"
                    value={grantPath}
                    placeholder="/"
                    onChange={(event) => setGrantPath(event.target.value)}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="grant-expiry">
                  Expires <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="grant-expiry"
                  type="datetime-local"
                  value={grantExpires}
                  onChange={(event) => setGrantExpires(event.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setGrantOpen(false)}>
                cancel
              </Button>
              <Button type="submit" disabled={busy || !grantUser || !grantRole}>
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
