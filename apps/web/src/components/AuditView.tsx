import { useEffect, useState } from "react";
import type { AuditLogDto, ProjectDto } from "@opensiel/shared";
import { RefreshCw, Search } from "lucide-react";
import { api } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Pagination } from "./Pagination";
import { useServerList } from "../hooks/useServerList";
import { notify } from "../lib/notify";

export function AuditView({ project }: { project: ProjectDto }) {
  const [actionFilter, setActionFilter] = useState("");

  const list = useServerList<AuditLogDto>({
    key: `${project.id}:${actionFilter}`,
    pageSize: 20,
    initialSort: "createdAt",
    initialOrder: "desc",
    fetcher: async ({ limit, offset, q, sort, order }) => {
      const params = new URLSearchParams({
        projectId: project.id,
        limit: String(limit),
        offset: String(offset),
        sort: sort || "createdAt",
        order,
      });
      if (q) params.set("q", q);
      if (actionFilter) params.set("action", actionFilter);
      const result = await api.get<{ logs: AuditLogDto[]; total: number }>(`/api/audit?${params}`);
      return { items: result.logs, total: result.total };
    },
  });

  useEffect(() => {
    if (list.error) notify.error(list.error);
  }, [list.error]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Audit log</h2>
          <p className="text-sm text-muted-foreground">
            Reads, writes, rollbacks, and identity usage for this project.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              className="pl-8"
              placeholder="Search actor, action, resource…"
              value={list.query}
              onChange={(event) => list.setQuery(event.target.value)}
            />
          </div>
          <Select
            value={actionFilter || "all"}
            onValueChange={(value) => setActionFilter(value === "all" ? "" : value)}
          >
            <SelectTrigger className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">all actions</SelectItem>
              <SelectItem value="secret.read">secret.read</SelectItem>
              <SelectItem value="secret.write">secret.write</SelectItem>
              <SelectItem value="secret.delete">secret.delete</SelectItem>
              <SelectItem value="secret.rollback">secret.rollback</SelectItem>
              <SelectItem value="identity.token">identity.token</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => list.reload()}>
            <RefreshCw className="size-4" /> refresh
          </Button>
        </div>
      </div>

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
            {list.items.map((log) => (
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
            {list.total === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No audit entries match.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pagination {...list.pagination} />
      </Card>
    </section>
  );
}

function formatDate(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}
