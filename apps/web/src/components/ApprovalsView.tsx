import { useCallback, useEffect, useState } from "react";
import type {
  ChangeRequestDto,
  ChangeRequestStatus,
  EnvironmentDto,
  EnvironmentImportDto,
  ProjectDto,
} from "@opensiel/shared";
import { Check, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { api, errorMessage } from "../api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Pagination } from "./Pagination";
import { usePagination } from "../hooks/usePagination";
import { Notice } from "./Notice";

interface Props {
  project: ProjectDto;
  currentUserId: string;
  canApprove: boolean;
  onRefresh: () => Promise<void>;
}

const STATUS_FILTERS: (ChangeRequestStatus | "all")[] = [
  "pending",
  "all",
  "approved",
  "rejected",
  "cancelled",
];

function statusVariant(status: ChangeRequestStatus) {
  if (status === "approved") return "success" as const;
  if (status === "rejected") return "destructive" as const;
  if (status === "cancelled") return "outline" as const;
  return "secondary" as const;
}

export function ApprovalsView({ project, currentUserId, canApprove, onRefresh }: Props) {
  const [requests, setRequests] = useState<ChangeRequestDto[]>([]);
  const [filter, setFilter] = useState<ChangeRequestStatus | "all">("pending");
  const [envs, setEnvs] = useState<EnvironmentDto[]>(project.environments);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [imports, setImports] = useState<Record<string, string>>({});
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvSlug, setNewEnvSlug] = useState("");
  const [envBusy, setEnvBusy] = useState(false);

  useEffect(() => {
    setEnvs(project.environments);
  }, [project.environments]);

  const loadImports = useCallback(async () => {
    if (!canApprove) return;
    try {
      const result = await api.get<{ imports: EnvironmentImportDto[] }>(
        `/api/projects/${project.id}/environment-imports`,
      );
      setImports(
        Object.fromEntries(
          result.imports.map((entry) => [entry.targetEnvironmentId, entry.sourceEnvironmentId]),
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id, canApprove]);

  useEffect(() => {
    void loadImports();
  }, [loadImports]);

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

  const requestPagination = usePagination(requests, {
    pageSize: 20,
    resetKey: `${project.id}:${filter}`,
  });

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

  async function savePolicy(
    environment: EnvironmentDto,
    next: { approvalRequired: boolean; requiredApprovals: number },
  ) {
    try {
      const result = await api.patch<{ environment: EnvironmentDto }>(
        `/api/projects/${project.id}/environments/${environment.id}/policy`,
        next,
      );
      setEnvs((current) =>
        current.map((candidate) =>
          candidate.id === environment.id ? { ...candidate, ...result.environment } : candidate,
        ),
      );
      setNotice(`policy updated for ${environment.slug}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function saveImport(environment: EnvironmentDto, sourceEnvironmentId: string | null) {
    try {
      await api.put(`/api/projects/${project.id}/environments/${environment.id}/imports`, {
        sourceEnvironmentId,
      });
      setImports((current) => {
        const next = { ...current };
        if (sourceEnvironmentId) next[environment.id] = sourceEnvironmentId;
        else delete next[environment.id];
        return next;
      });
      setNotice(
        sourceEnvironmentId
          ? `${environment.slug} now imports from ${
              envs.find((candidate) => candidate.id === sourceEnvironmentId)?.slug ?? "?"
            }`
          : `${environment.slug} no longer imports secrets`,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function createEnvironment(event: React.FormEvent) {
    event.preventDefault();
    if (!newEnvName.trim()) return;
    setEnvBusy(true);
    setError("");
    try {
      const result = await api.post<{ environment: EnvironmentDto }>(
        `/api/projects/${project.id}/environments`,
        { name: newEnvName.trim(), slug: newEnvSlug.trim() || undefined },
      );
      setEnvs((current) => [...current, result.environment]);
      setNewEnvName("");
      setNewEnvSlug("");
      setNotice(`environment ${result.environment.slug} created`);
      await onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setEnvBusy(false);
    }
  }

  async function deleteEnvironment(environment: EnvironmentDto) {
    if (!window.confirm(`Delete environment ${environment.slug}? It must have no secrets.`)) return;
    try {
      await api.del(`/api/projects/${project.id}/environments/${environment.id}`);
      setEnvs((current) => current.filter((entry) => entry.id !== environment.id));
      setNotice(`environment ${environment.slug} deleted`);
      await onRefresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Approvals</h2>
          <p className="text-sm text-muted-foreground">
            Changes to approval-enabled environments apply only after the required number of
            approvals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as ChangeRequestStatus | "all")}
          >
            <SelectTrigger className="h-8 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" /> refresh
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

      {canApprove && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Environments</h3>
            <p className="text-xs text-muted-foreground">
              Add environments beyond the default dev, staging, and prod, for example QA or UAT. An
              environment must have no secrets before it can be deleted.
            </p>
            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Environment</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {envs.map((environment) => (
                    <TableRow key={environment.id}>
                      <TableCell>
                        <Badge variant="outline">{environment.slug}</Badge>
                      </TableCell>
                      <TableCell>{environment.name}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={envs.length <= 1}
                          onClick={() => void deleteEnvironment(environment)}
                        >
                          delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={createEnvironment}
            >
              <div className="flex-1 space-y-2">
                <Label htmlFor="new-env-name">New environment</Label>
                <Input
                  id="new-env-name"
                  placeholder="UAT"
                  value={newEnvName}
                  onChange={(event) => setNewEnvName(event.target.value)}
                  required
                />
              </div>
              <div className="w-full space-y-2 sm:w-40">
                <Label htmlFor="new-env-slug">Slug (optional)</Label>
                <Input
                  id="new-env-slug"
                  placeholder="uat"
                  value={newEnvSlug}
                  onChange={(event) => setNewEnvSlug(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={envBusy}>
                {envBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                add environment
              </Button>
            </form>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Environment policies</h3>
            <p className="text-xs text-muted-foreground">
              Enable approvals per environment and choose how many approvals are required.
            </p>
            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Environment</TableHead>
                    <TableHead>Require approval</TableHead>
                    <TableHead>Approvals needed</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {envs.map((environment) => (
                    <PolicyRow
                      key={environment.id}
                      environment={environment}
                      onSave={(next) => void savePolicy(environment, next)}
                    />
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Environment imports</h3>
            <p className="text-xs text-muted-foreground">
              Merge another environment&apos;s secrets at read time. Values defined in the
              environment itself win.
            </p>
            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Environment</TableHead>
                    <TableHead>Imports from</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {envs.map((environment) => (
                    <ImportRow
                      key={environment.id}
                      environment={environment}
                      options={envs.filter((candidate) => candidate.id !== environment.id)}
                      current={imports[environment.id] ?? null}
                      onSave={(sourceId) => void saveImport(environment, sourceId)}
                    />
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        </>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Change requests</h3>
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Environment</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Approvals</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requestPagination.pageItems.map((request) => {
                const isOwn = request.requestedById === currentUserId;
                const pending = request.status === "pending";
                return (
                  <TableRow key={request.id}>
                    <TableCell>
                      <Badge variant="outline">{request.environmentSlug}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="bg-transparent p-0">{request.action}</code>
                        <span className="font-medium">{request.key}</span>
                      </div>
                      {request.path !== "/" && (
                        <div className="text-xs text-muted-foreground">{request.path}</div>
                      )}
                      {request.comment && (
                        <div className="text-xs text-muted-foreground">{request.comment}</div>
                      )}
                      {request.targetVersion !== null && (
                        <div className="text-xs text-muted-foreground">
                          target v{request.targetVersion}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {request.requestedByName}
                      <div className="text-xs text-muted-foreground">{request.requestedByType}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {request.approvals}/{request.requiredApprovals}
                      </Badge>
                      {request.approvedBy.length > 0 && (
                        <div className="text-xs text-muted-foreground">
                          {request.approvedBy.join(", ")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(request.status)}>{request.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {pending && canApprove && !isOwn && (
                          <>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => void decide(request, "approve")}
                            >
                              <Check className="size-3.5" /> approve
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => void decide(request, "reject")}
                            >
                              <X className="size-3.5" /> reject
                            </Button>
                          </>
                        )}
                        {pending && (isOwn || canApprove) && (
                          <Button size="sm" variant="ghost" onClick={() => void cancel(request)}>
                            cancel
                          </Button>
                        )}
                        {!pending && request.decisionNote && (
                          <span className="text-xs text-muted-foreground">
                            {request.decisionNote}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {requests.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No change requests.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pagination
            page={requestPagination.page}
            pageSize={requestPagination.pageSize}
            total={requestPagination.total}
            totalPages={requestPagination.totalPages}
            rangeStart={requestPagination.rangeStart}
            rangeEnd={requestPagination.rangeEnd}
            onPageChange={requestPagination.setPage}
            onPageSizeChange={requestPagination.setPageSize}
          />
        </Card>
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
    <TableRow>
      <TableCell>
        <Badge variant="outline">{environment.slug}</Badge>
      </TableCell>
      <TableCell>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={required}
            onCheckedChange={(checked) => setRequired(checked === true)}
          />
          {required ? "enabled" : "disabled"}
        </label>
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min={1}
          max={10}
          disabled={!required}
          className="h-8 w-20"
          value={count}
          onChange={(event) => setCount(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
        />
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onSave({ approvalRequired: required, requiredApprovals: count })}
        >
          save
        </Button>
      </TableCell>
    </TableRow>
  );
}

function ImportRow({
  environment,
  options,
  current,
  onSave,
}: {
  environment: EnvironmentDto;
  options: EnvironmentDto[];
  current: string | null;
  onSave: (sourceEnvironmentId: string | null) => void;
}) {
  const [source, setSource] = useState(current ?? "");

  useEffect(() => {
    setSource(current ?? "");
  }, [current]);

  return (
    <TableRow>
      <TableCell>
        <Badge variant="outline">{environment.slug}</Badge>
      </TableCell>
      <TableCell>
        <Select
          value={source || "none"}
          onValueChange={(value) => setSource(value === "none" ? "" : value)}
        >
          <SelectTrigger className={cn("h-8 w-40")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">none</SelectItem>
            {options.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="outline" onClick={() => onSave(source || null)}>
          save
        </Button>
      </TableCell>
    </TableRow>
  );
}
