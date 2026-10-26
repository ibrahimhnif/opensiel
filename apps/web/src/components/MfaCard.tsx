import { useEffect, useState } from "react";
import type { MfaSetupDto, MfaStatusDto } from "@opensiel/shared";
import QRCode from "react-qr-code";
import { api, errorMessage } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useToastMessage } from "../hooks/useToastMessage";

export function MfaCard({ isOwner }: { isOwner: boolean }) {
  const [status, setStatus] = useState<MfaStatusDto | null>(null);
  const [setup, setSetup] = useState<MfaSetupDto | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useToastMessage("success", notice, setNotice);
  useToastMessage("error", error, setError);

  async function load() {
    try {
      setStatus(await api.get<MfaStatusDto>("/api/auth/mfa"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function startSetup() {
    setBusy(true);
    setError("");
    try {
      setSetup(await api.post<MfaSetupDto>("/api/auth/mfa/setup"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function enable(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ recoveryCodes: string[] }>("/api/auth/mfa/verify", {
        code,
      });
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
      setNotice("MFA enabled");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/mfa/disable", { password, code: disableCode });
      setPassword("");
      setDisableCode("");
      setRecoveryCodes(null);
      setNotice("MFA disabled");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function togglePolicy() {
    if (!status) return;
    setBusy(true);
    setError("");
    try {
      await api.patch("/api/org/mfa", { required: !status.orgRequired });
      setNotice(status.orgRequired ? "MFA policy disabled" : "MFA policy enabled");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyCodes() {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setNotice("recovery codes copied");
    } catch {
      setError("clipboard is not available");
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Two-factor authentication</h2>
            <p className="text-sm text-muted-foreground">
              Time-based one-time codes from any authenticator app.
            </p>
          </div>
          {status && (
            <Badge variant={status.enabled ? "success" : "outline"}>
              {status.enabled ? "enabled" : "off"}
            </Badge>
          )}
        </div>

        {status?.enabled ? (
          <div className="space-y-4">
            <p className="text-sm">
              Recovery codes remaining: <strong>{status.recoveryCodesRemaining}</strong>
            </p>
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={disable}>
              <div className="space-y-2">
                <Label htmlFor="mfa-disable-password">Password</Label>
                <Input
                  id="mfa-disable-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mfa-disable-code">Code or recovery code</Label>
                <Input
                  id="mfa-disable-code"
                  value={disableCode}
                  onChange={(event) => setDisableCode(event.target.value)}
                  required
                />
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" variant="outline" disabled={busy}>
                  disable MFA
                </Button>
              </div>
            </form>
          </div>
        ) : setup ? (
          <form className="space-y-4" onSubmit={enable}>
            <div className="flex justify-center rounded-lg bg-white p-3">
              <QRCode value={setup.otpauthUrl} size={160} />
            </div>
            <div className="space-y-1">
              <Label>Manual secret</Label>
              <code className="block rounded bg-muted px-2 py-1 text-xs break-all">
                {setup.secret}
              </code>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mfa-enable-code">Code</Label>
              <Input
                id="mfa-enable-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                enable
              </Button>
              <Button type="button" variant="outline" onClick={() => setSetup(null)}>
                cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button onClick={() => void startSetup()} disabled={busy}>
            set up authenticator
          </Button>
        )}

        {recoveryCodes && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Save these recovery codes now</p>
            <p className="text-xs text-muted-foreground">
              Each code works once and they are not shown again.
            </p>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs">
              {recoveryCodes.map((recoveryCode) => (
                <span key={recoveryCode}>{recoveryCode}</span>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => void copyCodes()}>
              copy
            </Button>
          </div>
        )}

        <div className="border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Organization policy</p>
              <p className="text-xs text-muted-foreground">
                Require MFA for password logins in this organization.
              </p>
            </div>
            {isOwner ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void togglePolicy()}
                disabled={busy || !status}
              >
                {status?.orgRequired ? "turn off" : "require MFA"}
              </Button>
            ) : (
              <Badge variant="outline">{status?.orgRequired ? "required" : "optional"}</Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
