import { useCallback, useEffect, useState } from "react";
import type { ProjectDto, WebhookDto, WebhookEvent } from "@opensiel/shared";
import { webhookEvents } from "@opensiel/shared";
import { Copy, Loader2, Plus, RefreshCw, Send, Trash2, Webhook, X } from "lucide-react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Notice } from "./Notice";

interface CreatedWebhook {
  url: string;
  signingSecret: string;
}

export function WebhooksView({ project }: { project: ProjectDto }) {
  const [rows, setRows] = useState<WebhookDto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["secret.created", "secret.updated"]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ webhooks: WebhookDto[] }>(
        `/api/projects/${project.id}/webhooks`,
      );
      setRows(result.webhooks);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleEvent(event: WebhookEvent) {
    setEvents((current) =>
      current.includes(event) ? current.filter((value) => value !== event) : [...current, event],
    );
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ webhook: WebhookDto; signingSecret: string }>(
        `/api/projects/${project.id}/webhooks`,
        { url: url.trim(), events },
      );
      setCreated({ url: result.webhook.url, signingSecret: result.signingSecret });
      setOpen(false);
      setUrl("");
      setNotice("webhook created");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(webhook: WebhookDto) {
    try {
      await api.patch(`/api/projects/${project.id}/webhooks/${webhook.id}`, {
        enabled: !webhook.enabled,
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function test(webhook: WebhookDto) {
    try {
      const result = await api.post<{
        delivered: boolean;
        status: number | null;
        error: string | null;
      }>(`/api/projects/${project.id}/webhooks/${webhook.id}/test`);
      setNotice(
        result.delivered
          ? `test delivered (HTTP ${result.status})`
          : `test failed: ${result.error ?? "unknown error"}`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(webhook: WebhookDto) {
    if (!window.confirm(`Delete the webhook for ${webhook.url}?`)) return;
    try {
      await api.del(`/api/projects/${project.id}/webhooks/${webhook.id}`);
      setNotice("webhook deleted");
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
          <h2 className="text-lg font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Send signed event payloads to an HTTPS endpoint. Payloads never include secret values.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" /> refresh
          </Button>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> new webhook
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
            <div className="min-w-0 space-y-2">
              <p className="flex items-center gap-2 font-medium">
                <Webhook className="size-4" /> Signing secret — shown once
              </p>
              <code className="block break-all bg-transparent p-0 text-xs">
                {created.signingSecret}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(created.signingSecret, "signing secret")}
                >
                  <Copy className="size-3.5" /> copy
                </Button>
                <span className="text-xs opacity-80">
                  Verify <code>x-opensiel-signature: sha256=&lt;hmac&gt;</code> with this value.
                </span>
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
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Last delivery</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((webhook) => (
              <TableRow key={webhook.id}>
                <TableCell className="max-w-sm truncate">
                  <code className="bg-transparent p-0 text-xs">{webhook.url}</code>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {webhook.events.map((event) => (
                      <Badge key={event} variant="outline">
                        {event}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={webhook.enabled ? "success" : "destructive"}>
                    {webhook.enabled ? "enabled" : "disabled"}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {webhook.lastDeliveryAt ? (
                    <>
                      HTTP {webhook.lastStatus ?? "—"} · {formatDate(webhook.lastDeliveryAt)}
                      {webhook.lastError && (
                        <div className="text-destructive">{webhook.lastError}</div>
                      )}
                      {webhook.failureCount > 0 && (
                        <div>{webhook.failureCount} consecutive failure(s)</div>
                      )}
                    </>
                  ) : (
                    "never"
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void test(webhook)}>
                      <Send className="size-3.5" /> test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggle(webhook)}>
                      {webhook.enabled ? "disable" : "enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void remove(webhook)}
                    >
                      <Trash2 className="size-3.5" /> delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No webhooks yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <form className="space-y-4" onSubmit={create}>
            <DialogHeader>
              <DialogTitle>New webhook</DialogTitle>
              <DialogDescription>
                A signing secret is generated and shown once after creation.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="webhook-url">Endpoint URL</Label>
              <Input
                id="webhook-url"
                autoFocus
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/hooks/opensiel"
                required
              />
            </div>

            <div className="space-y-2">
              <Label>Events</Label>
              <div className="grid grid-cols-1 gap-2 rounded-lg border px-3 py-3 sm:grid-cols-2">
                {webhookEvents.map((event) => (
                  <label key={event} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={events.includes(event)}
                      onCheckedChange={() => toggleEvent(event)}
                    />
                    {event}
                  </label>
                ))}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                cancel
              </Button>
              <Button type="submit" disabled={busy || events.length === 0}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? "creating…" : "create webhook"}
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
