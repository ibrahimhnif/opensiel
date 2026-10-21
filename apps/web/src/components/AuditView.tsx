import { useCallback, useEffect, useState } from "react";
import type { AuditLogDto, ProjectDto } from "@opensiel/shared";
import { RefreshCw } from "lucide-react";
import { api, errorMessage } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Pagination } from "./Pagination";
import { usePagination } from "../hooks/usePagination";
import { Notice } from "./Notice";

export function AuditView({ project }: { project: ProjectDto }) {
  const [logs, setLogs] = useState<AuditLogDto[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ logs: AuditLogDto[] }>(
        `/api/audit?projectId=${project.id}&limit=100`,
      );
      setLogs(result.logs);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pagination = usePagination(logs, { pageSize: 20, resetKey: project.id });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Audit log</h2>
          <p className="text-sm text-muted-foreground">
            Reads, writes, rollbacks, and identity usage for this project.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-4" /> refresh
        </Button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead className="hidden lg:table-cell">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pagination.pageItems.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(log.createdAt)}
                </TableCell>
                <TableCell>
                  {log.actorName}
                  <div className="text-xs text-muted-foreground">{log.actorType}</div>
                </TableCell>
                <TableCell>
                  <code className="bg-transparent p-0 text-xs">{log.action}</code>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{log.resourceType}</Badge>
                </TableCell>
                <TableCell className="hidden max-w-md truncate text-xs text-muted-foreground lg:table-cell">
                  {Object.entries(log.metadata)
                    .filter(([, value]) => typeof value !== "object")
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(" · ")}
                </TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No audit entries yet.
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
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
