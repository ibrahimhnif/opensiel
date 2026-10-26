import { useState } from "react";
import type { ProjectDto, ScanResult } from "@opensiel/shared";
import { Loader2, ScanSearch, Upload } from "lucide-react";
import { api, errorMessage } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Pagination } from "./Pagination";
import { Textarea } from "./ui/textarea";
import { Notice } from "./Notice";
import { useToastMessage } from "../hooks/useToastMessage";

const PAGE_SIZE = 20;

export function ScanView({ project }: { project: ProjectDto }) {
  const [contents, setContents] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  useToastMessage("error", error, setError);

  async function scan(pageNumber = 1) {
    if (!contents.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await api.post<ScanResult>(
        `/api/projects/${project.id}/scan?limit=${PAGE_SIZE}&offset=${(pageNumber - 1) * PAGE_SIZE}`,
        { contents },
      );
      setResult(response);
      setPage(pageNumber);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function readFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setContents(await file.text());
    setResult(null);
    setPage(1);
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Secret scanning</h2>
          <p className="text-sm text-muted-foreground">
            Check a file, log, or pasted text for values stored in this project and for common
            credential patterns. Nothing is stored.
          </p>
        </div>
      </div>

      {result && (
        <Notice
          tone={result.findings.length > 0 ? "error" : "success"}
          onDismiss={() => setResult(null)}
        >
          {result.total > 0
            ? `${result.total} potential leak(s) found in ${result.characters} characters.`
            : `No leaks found in ${result.characters} characters.`}{" "}
          Scanned {result.scannedSecrets} secrets across {result.scannedEnvironments} environments.
        </Notice>
      )}

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full max-w-sm space-y-2">
            <Label htmlFor="scan-file">Upload a file</Label>
            <Input
              id="scan-file"
              type="file"
              accept=".env,.txt,.json,.yml,.yaml,.log,text/plain"
              onChange={(event) => void readFile(event)}
            />
          </div>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Upload className="size-3.5" /> or paste below
          </span>
        </div>

        <div className="space-y-2">
          <Label htmlFor="scan-contents">Text to scan</Label>
          <Textarea
            id="scan-contents"
            rows={10}
            value={contents}
            onChange={(event) => {
              setContents(event.target.value);
              setResult(null);
            }}
            placeholder={
              "Paste a .env, a source file, a log line…\n\nDATABASE_URL=postgres://user:pass@host/db\nAWS_ACCESS_KEY_ID=AKIA…"
            }
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setContents("");
              setResult(null);
            }}
          >
            clear
          </Button>
          <Button onClick={() => void scan()} disabled={busy || !contents.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ScanSearch className="size-4" />}
            {busy ? "scanning…" : "scan"}
          </Button>
        </div>
      </Card>

      {result && (
        <Card className="overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Preview</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.findings.map((finding, index) => (
                <TableRow key={`${finding.type}-${finding.name}-${finding.line}-${index}`}>
                  <TableCell className="font-mono text-xs">{finding.line}</TableCell>
                  <TableCell>
                    <Badge variant={finding.type === "stored-secret" ? "destructive" : "outline"}>
                      {finding.type === "stored-secret" ? "stored secret" : "pattern"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {finding.type === "stored-secret" ? (
                      <code className="bg-transparent p-0">{finding.name}</code>
                    ) : (
                      finding.name
                    )}
                    {finding.path && finding.path !== "/" && (
                      <div className="text-xs text-muted-foreground">{finding.path}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {finding.environment ? (
                      <Badge variant="outline">{finding.environment}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {finding.preview}
                  </TableCell>
                </TableRow>
              ))}
              {result.total === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No findings.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={result.total}
            totalPages={Math.max(1, Math.ceil(result.total / PAGE_SIZE))}
            rangeStart={result.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
            rangeEnd={Math.min(page * PAGE_SIZE, result.total)}
            onPageChange={(next) => void scan(next)}
            onPageSizeChange={() => {}}
          />
        </Card>
      )}
    </section>
  );
}
