import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportSecretsResult,
  ProjectDto,
  SecretDto,
  SecretVersionDto,
} from "@opensiel/shared";
import {
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Pagination } from "./Pagination";
import { usePagination } from "../hooks/usePagination";
import { Textarea } from "./ui/textarea";
import { Notice } from "./Notice";

interface Props {
  project: ProjectDto;
  env: string;
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
}

export function SecretsView({ project, env }: Props) {
  const [rows, setRows] = useState<SecretDto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPath, setImportPath] = useState("/");
  const [importComment, setImportComment] = useState("");
  const [importPreview, setImportPreview] = useState<string[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ secrets: SecretDto[] }>(
        `/api/projects/${project.id}/secrets?env=${encodeURIComponent(env)}`,
      );
      setRows(result.secrets);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [project.id, env]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.key.toLowerCase().includes(needle) ||
        row.path.toLowerCase().includes(needle) ||
        row.value.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  const pagination = usePagination(filtered, {
    pageSize: 20,
    resetKey: `${project.id}:${env}:${query}`,
  });
  const historyPagination = usePagination(history?.versions ?? [], {
    pageSize: 10,
    resetKey: `${history?.key ?? ""}:${history?.path ?? ""}`,
  });

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
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: SecretDto) {
    if (!window.confirm(`Delete ${row.key} from ${env}? Version history is kept.`)) return;
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
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function openHistory(row: SecretDto) {
    try {
      const params = new URLSearchParams({ env, path: row.path });
      const result = await api.get<{ versions: SecretVersionDto[] }>(
        `/api/projects/${project.id}/secrets/${encodeURIComponent(row.key)}/versions?${params}`,
      );
      setHistory({ key: row.key, path: row.path, versions: result.versions });
    } catch (err) {
      setError(errorMessage(err));
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
      await load();
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
      await load();
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
            placeholder="Search keys, paths, values…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            refresh
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
            {pagination.pageItems.map((row) => {
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
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  {rows.length === 0 ? `No secrets in ${env} yet.` : "No matches."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          totalPages={pagination.totalPages}
          rangeStart={pagination.rangeStart}
          rangeEnd={pagination.rangeEnd}
          onPageChange={pagination.setPage}
          onPageSizeChange={pagination.setPageSize}
        />
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
          if (!open) setHistory(null);
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

              <div className="space-y-2">
                {historyPagination.pageItems.map((version) => (
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
                page={historyPagination.page}
                pageSize={historyPagination.pageSize}
                total={historyPagination.total}
                totalPages={historyPagination.totalPages}
                rangeStart={historyPagination.rangeStart}
                rangeEnd={historyPagination.rangeEnd}
                onPageChange={historyPagination.setPage}
                onPageSizeChange={historyPagination.setPageSize}
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
