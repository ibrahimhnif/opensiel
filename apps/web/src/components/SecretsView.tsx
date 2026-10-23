import { useEffect, useState } from "react";
import type {
  ImportSecretsResult,
  ProjectDto,
  SecretDto,
  SecretVersionDto,
} from "@opensiel/shared";
import {
  Clock,
  Copy,
  Eye,
  EyeOff,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { api, errorMessage } from "../api";
import { cn } from "../lib/utils";
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
import { Textarea } from "./ui/textarea";
import { Notice } from "./Notice";
import { useToastMessage } from "../hooks/useToastMessage";
import { useConfirm } from "./ConfirmProvider";

interface Props {
  project: ProjectDto;
  env: string;
  canManage?: boolean;
}

interface EditorState {
  key: string;
  value: string;
  path: string;
  comment: string;
  isNew: boolean;
}

interface HistoryState {
  key: string;
  path: string;
  versions: SecretVersionDto[];
  from: number;
  to: number;
}

interface SecretDiff {
  key: string;
  path: string;
  env: string;
  changed: boolean;
  revealed: boolean;
  from: { version: number; value: string; createdAt: string };
  to: { version: number; value: string; createdAt: string };
}

type PitrAction = "restore" | "revive" | "delete";

interface PitrChange {
  key: string;
  path: string;
  action: PitrAction;
  currentVersion: number;
  targetVersion: number | null;
}

interface PitrPreview {
  at: string;
  env: string;
  secretCount: number;
  changes: PitrChange[];
}

export function SecretsView({ project, env, canManage = false }: Props) {
  const confirm = useConfirm();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [diff, setDiff] = useState<SecretDiff | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [pitrOpen, setPitrOpen] = useState(false);
  const [pitrAt, setPitrAt] = useState(() => toLocalInput(new Date(Date.now() - 3_600_000)));
  const [pitrPreview, setPitrPreview] = useState<PitrPreview | null>(null);
  const [pitrBusy, setPitrBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPath, setImportPath] = useState("/");
  const [importComment, setImportComment] = useState("");
  const [importPreview, setImportPreview] = useState<string[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  useToastMessage("success", notice, setNotice);
  useToastMessage("error", error, setError);

  const list = useServerList<SecretDto>({
    key: `${project.id}:${env}`,
    pageSize: 20,
    initialSort: "key",
    initialOrder: "asc",
    fetcher: async ({ limit, offset, q, sort, order }) => {
      const params = new URLSearchParams({
        env,
        limit: String(limit),
        offset: String(offset),
        order,
      });
      if (q) params.set("q", q);
      if (sort) params.set("sort", sort);
      const result = await api.get<{ secrets: SecretDto[]; total: number }>(
        `/api/projects/${project.id}/secrets?${params}`,
      );
      return { items: result.secrets, total: result.total };
    },
  });

  useEffect(() => {
    if (list.error) notify.error(list.error);
  }, [list.error]);

  async function loadHistoryPage(key: string, path: string, pageNumber: number) {
    const params = new URLSearchParams({
      env,
      path,
      limit: "10",
      offset: String((pageNumber - 1) * 10),
      sort: "version",
      order: "desc",
    });
    const result = await api.get<{ versions: SecretVersionDto[]; total: number }>(
      `/api/projects/${project.id}/secrets/${encodeURIComponent(key)}/versions?${params}`,
    );
    setHistoryTotal(result.total);
    setHistoryPage(pageNumber);
    return result.versions;
  }

  async function changeHistoryPage(pageNumber: number) {
    if (!history) return;
    try {
      const versions = await loadHistoryPage(history.key, history.path, pageNumber);
      setHistory({ ...history, versions });
      setDiff(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const activeEnvironment = project.environments.find((environment) => environment.slug === env);

  function rowId(row: SecretDto) {
    return `${row.path}:${row.key}`;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{
        secret?: { version: number };
        changeRequest?: { id: string; requiredApprovals: number };
      }>(`/api/projects/${project.id}/secrets`, {
        key: editor.key.trim(),
        value: editor.value,
        env,
        path: editor.path.trim() || "/",
        comment: editor.comment.trim() || undefined,
      });
      setEditor(null);
      setNotice(
        result.changeRequest
          ? `change submitted for approval (${result.changeRequest.id.slice(0, 8)})`
          : "secret saved",
      );
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: SecretDto) {
    if (
      !(await confirm({
        title: `Delete ${row.key}?`,
        description: `Removes it from ${env}. Version history is kept.`,
        confirmLabel: "delete",
        destructive: true,
      }))
    )
      return;
    try {
      const params = new URLSearchParams({ env, path: row.path });
      const result = await api.del<{ ok?: boolean; changeRequest?: { id: string } }>(
        `/api/projects/${project.id}/secrets/${encodeURIComponent(row.key)}?${params}`,
      );
      setNotice(
        result.changeRequest
          ? `delete submitted for approval (${result.changeRequest.id.slice(0, 8)})`
          : "secret deleted",
      );
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openHistory(row: SecretDto) {
    try {
      const versions = await loadHistoryPage(row.key, row.path, 1);
      setDiff(null);
      setHistory({
        key: row.key,
        path: row.path,
        versions,
        from: versions[1]?.version ?? versions[0]?.version ?? 0,
        to: versions[0]?.version ?? 0,
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function loadDiff(reveal = false) {
    if (!history) return;
    if (history.from === history.to) {
      setError("pick two different versions");
      return;
    }
    setDiffBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({
        env,
        path: history.path,
        from: String(history.from),
        to: String(history.to),
      });
      if (reveal) params.set("reveal", "true");
      const result = await api.get<{ diff: SecretDiff }>(
        `/api/projects/${project.id}/secrets/${encodeURIComponent(history.key)}/diff?${params}`,
      );
      setDiff(result.diff);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDiffBusy(false);
    }
  }

  async function previewPointInTime() {
    const at = new Date(pitrAt);
    if (Number.isNaN(at.getTime())) {
      setError("pick a valid timestamp");
      return;
    }
    setPitrBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ env, at: at.toISOString() });
      const result = await api.get<PitrPreview>(
        `/api/projects/${project.id}/point-in-time?${params}`,
      );
      setPitrPreview(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPitrBusy(false);
    }
  }

  async function restorePointInTime() {
    const at = new Date(pitrAt);
    if (!pitrPreview || Number.isNaN(at.getTime())) return;
    if (
      !(await confirm({
        title: `Restore ${env}?`,
        description: `Restores to ${pitrPreview.at}. Changed keys get a new version, deleted keys are revived, and keys created after that time are deleted.`,
        confirmLabel: "restore",
        destructive: true,
      }))
    )
      return;
    setPitrBusy(true);
    setError("");
    try {
      const result = await api.post<{ restored: number; revived: number; deleted: number }>(
        `/api/projects/${project.id}/point-in-time/restore`,
        { env, at: at.toISOString(), dryRun: false },
      );
      setPitrOpen(false);
      setPitrPreview(null);
      setNotice(
        `restored ${result.restored}, revived ${result.revived}, deleted ${result.deleted}`,
      );
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPitrBusy(false);
    }
  }

  async function rollback(version: number) {
    if (!history) return;
    try {
      const result = await api.post<{
        secret?: { version: number };
        changeRequest?: { id: string };
      }>(`/api/projects/${project.id}/secrets/${encodeURIComponent(history.key)}/rollback`, {
        version,
        env,
        path: history.path,
      });
      setHistory(null);
      setNotice(
        result.changeRequest
          ? `rollback submitted for approval (${result.changeRequest.id.slice(0, 8)})`
          : `rolled back ${history.key} to v${version}`,
      );
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("copied to clipboard");
    } catch {
      setError("clipboard is not available");
    }
  }

  async function readImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportText(await file.text());
    setImportPreview(null);
  }

  async function previewImport() {
    if (!importText.trim()) {
      setError("paste or upload a .env file first");
      return;
    }
    setImportBusy(true);
    setError("");
    try {
      const result = await api.post<ImportSecretsResult>(
        `/api/projects/${project.id}/secrets/import`,
        {
          env,
          path: importPath.trim() || "/",
          format: "env",
          contents: importText,
          comment: importComment.trim() || undefined,
          dryRun: true,
        },
      );
      setImportPreview(result.keys);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImportBusy(false);
    }
  }

  async function runImport() {
    if (!importText.trim()) return;
    setImportBusy(true);
    setError("");
    try {
      const result = await api.post<ImportSecretsResult>(
        `/api/projects/${project.id}/secrets/import`,
        {
          env,
          path: importPath.trim() || "/",
          format: "env",
          contents: importText,
          comment: importComment.trim() || undefined,
        },
      );
      setNotice(
        `imported ${result.imported.length} secrets (${result.created} new, ${result.updated} updated)`,
      );
      setImportOpen(false);
      setImportText("");
      setImportPath("/");
      setImportComment("");
      setImportPreview(null);
      list.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            className="pl-8"
            placeholder="Search keys or paths…"
            value={list.query}
            onChange={(event) => list.setQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={list.sort || "key"} onValueChange={(value) => list.setSort(value)}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="key">sort: key</SelectItem>
              <SelectItem value="path">sort: path</SelectItem>
              <SelectItem value="version">sort: version</SelectItem>
              <SelectItem value="updatedAt">sort: updated</SelectItem>
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
            <RefreshCw className={cn("size-4", list.loading && "animate-spin")} />
            refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPitrOpen(true);
              setPitrPreview(null);
            }}
          >
            <Clock className="size-4" />
            point in time
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setImportOpen(true);
              setImportPreview(null);
            }}
          >
            <Upload className="size-4" />
            import .env
          </Button>
          <Button
            size="sm"
            onClick={() => setEditor({ key: "", value: "", path: "/", comment: "", isNew: true })}
          >
            <Plus className="size-4" />
            new secret
          </Button>
        </div>
      </div>

      {activeEnvironment?.approvalRequired && (
        <Notice>
          Changes to <code>{env}</code> require {activeEnvironment.requiredApprovals} approval(s)
          before they are applied.
        </Notice>
      )}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="hidden sm:table-cell">Version</TableHead>
              <TableHead className="hidden md:table-cell">Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((row) => {
              const id = rowId(row);
              const isRevealed = Boolean(revealed[id]);
              return (
                <TableRow key={id}>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="bg-transparent p-0 text-sm">{row.key}</code>
                      {row.importedFrom && <Badge variant="outline">from {row.importedFrom}</Badge>}
                    </div>
                    {row.path !== "/" && (
                      <div className="text-xs text-muted-foreground">{row.path}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span
                        className={cn(
                          "font-mono text-xs",
                          !isRevealed && "tracking-widest text-muted-foreground",
                        )}
                      >
                        {isRevealed ? row.value : "••••••••••••"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title={isRevealed ? "hide" : "reveal"}
                        onClick={() =>
                          setRevealed((current) => ({ ...current, [id]: !current[id] }))
                        }
                      >
                        {isRevealed ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="copy"
                        onClick={() => void copy(row.value)}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="outline">v{row.version}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {formatDate(row.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEditor({
                            key: row.key,
                            value: row.value,
                            path: row.path,
                            comment: "",
                            isNew: false,
                          })
                        }
                      >
                        <Pencil className="size-3.5" /> edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openHistory(row)}>
                        <History className="size-3.5" /> history
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void remove(row)}
                      >
                        <Trash2 className="size-3.5" /> delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {list.total === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  {list.query ? "No matches." : `No secrets in ${env} yet.`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination {...list.pagination} />
      </Card>

      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent>
          {editor && (
            <form className="space-y-4" onSubmit={save}>
              <DialogHeader>
                <DialogTitle>{editor.isNew ? "New secret" : `Edit ${editor.key}`}</DialogTitle>
                <DialogDescription>
                  Writing creates a new immutable version in <code>{env}</code>.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2">
                <Label htmlFor="secret-key">Key</Label>
                <Input
                  id="secret-key"
                  autoFocus
                  value={editor.key}
                  disabled={!editor.isNew}
                  placeholder="DATABASE_URL"
                  onChange={(event) => setEditor({ ...editor, key: event.target.value })}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="secret-value">Value</Label>
                <Textarea
                  id="secret-value"
                  rows={6}
                  value={editor.value}
                  placeholder="postgres://…"
                  onChange={(event) => setEditor({ ...editor, value: event.target.value })}
                  required
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="secret-path">Folder path</Label>
                  <Input
                    id="secret-path"
                    value={editor.path}
                    placeholder="/"
                    onChange={(event) => setEditor({ ...editor, path: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secret-comment">
                    Comment <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="secret-comment"
                    value={editor.comment}
                    placeholder="rotated by hand"
                    onChange={(event) => setEditor({ ...editor, comment: event.target.value })}
                  />
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditor(null)}>
                  cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {busy ? "saving…" : "save version"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(history)}
        onOpenChange={(open) => {
          if (!open) {
            setHistory(null);
            setDiff(null);
          }
        }}
      >
        <DialogContent>
          {history && (
            <>
              <DialogHeader>
                <DialogTitle>
                  History · <code>{history.key}</code>
                </DialogTitle>
                <DialogDescription>
                  {history.path} · {env}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">compare</span>
                  <Select
                    value={String(history.from)}
                    onValueChange={(value) => {
                      setDiff(null);
                      setHistory({ ...history, from: Number(value) });
                    }}
                  >
                    <SelectTrigger className="h-8 w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {history.versions.map((version) => (
                        <SelectItem key={version.version} value={String(version.version)}>
                          v{version.version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">→</span>
                  <Select
                    value={String(history.to)}
                    onValueChange={(value) => {
                      setDiff(null);
                      setHistory({ ...history, to: Number(value) });
                    }}
                  >
                    <SelectTrigger className="h-8 w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {history.versions.map((version) => (
                        <SelectItem key={version.version} value={String(version.version)}>
                          v{version.version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void loadDiff(Boolean(diff?.revealed))}
                    disabled={diffBusy}
                  >
                    {diffBusy && <Loader2 className="size-3.5 animate-spin" />}
                    compare
                  </Button>
                </div>

                {diff && (
                  <div className="space-y-1">
                    {diff.changed ? (
                      <>
                        <div className="rounded bg-destructive/10 px-2 py-1 font-mono text-xs break-all">
                          - v{diff.from.version}: {diff.from.value}
                        </div>
                        <div className="rounded bg-primary/10 px-2 py-1 font-mono text-xs break-all">
                          + v{diff.to.version}: {diff.to.value}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        no change between v{diff.from.version} and v{diff.to.version}
                      </p>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void loadDiff(!diff.revealed)}
                      disabled={diffBusy}
                    >
                      {diff.revealed ? "hide values" : "reveal values"}
                    </Button>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                {history.versions.map((version) => (
                  <div
                    key={version.version}
                    className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">v{version.version}</Badge>
                        {version.current && <Badge>current</Badge>}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatDate(version.createdAt)} · {version.comment ?? "—"} · by{" "}
                        {version.createdByType}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={version.current}
                      onClick={() => void rollback(version.version)}
                    >
                      rollback
                    </Button>
                  </div>
                ))}
              </div>
              <Pagination
                page={historyPage}
                pageSize={10}
                total={historyTotal}
                totalPages={Math.max(1, Math.ceil(historyTotal / 10))}
                rangeStart={historyTotal === 0 ? 0 : (historyPage - 1) * 10 + 1}
                rangeEnd={Math.min(historyPage * 10, historyTotal)}
                onPageChange={(page) => void changeHistoryPage(page)}
                onPageSizeChange={() => {}}
                className="border-0 px-0"
              />

              <DialogFooter>
                <Button variant="outline" onClick={() => setHistory(null)}>
                  close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={pitrOpen} onOpenChange={setPitrOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Point-in-time · {env}</DialogTitle>
            <DialogDescription>
              Preview the environment at a timestamp, then restore changed keys as new versions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="pitr-at">Timestamp (local)</Label>
            <Input
              id="pitr-at"
              type="datetime-local"
              value={pitrAt}
              onChange={(event) => {
                setPitrAt(event.target.value);
                setPitrPreview(null);
              }}
            />
          </div>

          {pitrPreview && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {pitrPreview.secretCount} secret(s) at {formatDate(pitrPreview.at)}
              </p>
              {pitrPreview.changes.length === 0 ? (
                <p className="text-sm">No changes needed.</p>
              ) : (
                <div className="max-h-64 space-y-1 overflow-auto">
                  {pitrPreview.changes.map((change) => (
                    <div
                      key={`${change.path}:${change.key}`}
                      className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
                    >
                      <span className="font-mono">
                        {change.path === "/" ? change.key : `${change.path}/${change.key}`}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">
                          v{change.currentVersion} →{" "}
                          {change.targetVersion === null ? "—" : `v${change.targetVersion}`}
                        </span>
                        <Badge variant={change.action === "delete" ? "destructive" : "success"}>
                          {change.action}
                        </Badge>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPitrOpen(false)}>
              cancel
            </Button>
            <Button variant="outline" onClick={() => void previewPointInTime()} disabled={pitrBusy}>
              {pitrBusy && <Loader2 className="size-4 animate-spin" />}
              preview
            </Button>
            {canManage && (
              <Button
                onClick={() => void restorePointInTime()}
                disabled={pitrBusy || !pitrPreview || pitrPreview.changes.length === 0}
              >
                restore
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import secrets</DialogTitle>
            <DialogDescription>
              Paste a .env file or choose one. Supports comments, <code>export KEY=…</code>, and
              quoted values. Existing keys get a new version.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="import-file">Choose a file</Label>
            <Input
              id="import-file"
              type="file"
              accept=".env,text/plain"
              onChange={(event) => void readImportFile(event)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-text">Paste .env</Label>
            <Textarea
              id="import-text"
              rows={10}
              value={importText}
              onChange={(event) => {
                setImportText(event.target.value);
                setImportPreview(null);
              }}
              placeholder={
                '# comment\nDATABASE_URL=postgres://user:pass@host/db\nAPI_KEY="quoted value"\nexport DEBUG=true'
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="import-path">Folder path</Label>
              <Input
                id="import-path"
                value={importPath}
                placeholder="/"
                onChange={(event) => setImportPath(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="import-comment">
                Comment <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="import-comment"
                value={importComment}
                placeholder="bulk import"
                onChange={(event) => setImportComment(event.target.value)}
              />
            </div>
          </div>

          {importPreview && (
            <p className="text-xs text-muted-foreground">
              {importPreview.length} key(s): {importPreview.join(", ")}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              cancel
            </Button>
            <Button variant="outline" onClick={() => void previewImport()} disabled={importBusy}>
              preview
            </Button>
            <Button onClick={() => void runImport()} disabled={importBusy || !importText.trim()}>
              {importBusy && <Loader2 className="size-4 animate-spin" />}
              {importBusy
                ? "working…"
                : importPreview
                  ? `import ${importPreview.length} secrets`
                  : "import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}

function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
