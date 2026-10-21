import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";
import { api, errorMessage } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Notice } from "./Notice";

interface KeyStatus {
  currentVersion: number;
  nextConfigured: boolean;
  nextVersion: number | null;
  projects: { version: number; count: number }[];
}

export function KeyRotationCard() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<KeyStatus>("/api/admin/key"));
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rotate() {
    if (
      !window.confirm(
        "Rewrap every project data key with the next master key? This is safe while the old key is still configured.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ rotated: number; skipped: number; targetVersion: number }>(
        "/api/admin/rotate-key",
      );
      setNotice(
        `rewrapped ${result.rotated} project(s) to key version ${result.targetVersion}${result.skipped > 0 ? `, ${result.skipped} already current` : ""}`,
      );
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Encryption key</h3>
      <p className="text-xs text-muted-foreground">
        To rotate, set <code>OPENSIEL_MASTER_KEY_NEXT</code> (and optionally{" "}
        <code>OPENSIEL_MASTER_KEY_NEXT_VERSION</code>), restart, rewrap projects here, then
        promote the next key to <code>OPENSIEL_MASTER_KEY</code> and remove the old one.
      </p>
      <Card className="space-y-3 p-4">
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

        {status ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">current v{status.currentVersion}</Badge>
                {status.nextConfigured ? (
                  <Badge variant="success">next v{status.nextVersion}</Badge>
                ) : (
                  <Badge variant="destructive">no next key configured</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {status.projects.length === 0
                  ? "No projects yet."
                  : status.projects
                      .map((entry) => `${entry.count} project(s) on v${entry.version}`)
                      .join(" · ")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw className="size-4" /> refresh
              </Button>
              <Button
                size="sm"
                onClick={() => void rotate()}
                disabled={busy || !status.nextConfigured}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                rotate keys
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">loading…</p>
        )}
      </Card>
    </div>
  );
}
