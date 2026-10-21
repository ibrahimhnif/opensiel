import { useEffect, useState } from "react";
import type { InviteInfoDto, UserDto } from "@opensiel/shared";
import { Diamond, Loader2 } from "lucide-react";
import { api, errorMessage } from "../api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Notice } from "./Notice";

interface Props {
  token: string;
  onDone: (user: UserDto) => void;
  onCancel: () => void;
}

export function AcceptInvite({ token, onDone, onCancel }: Props) {
  const [info, setInfo] = useState<InviteInfoDto | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.get<{ invite: InviteInfoDto }>(
          `/api/auth/invite?token=${encodeURIComponent(token)}`,
        );
        if (!cancelled) setInfo(result.invite);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ user: UserDto }>("/api/auth/accept-invite", {
        token,
        name: name.trim() || undefined,
        password,
      });
      onDone(result.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!info && !error) {
    return (
      <div className="grid min-h-full place-items-center p-6 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> loading invite…
        </span>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <Card className="w-full max-w-sm gap-3">
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-lg font-semibold">
              <Diamond className="size-5 text-primary" /> opensiel
            </div>
            <h2 className="font-semibold">Invite unavailable</h2>
            <Notice tone="error">{error}</Notice>
            <Button variant="link" className="h-auto p-0 text-xs" onClick={onCancel}>
              back to sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center justify-center gap-2 text-xl font-semibold tracking-tight">
          <Diamond className="size-5 text-primary" />
          opensiel
        </div>

        <Card className="gap-4">
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                Join <strong className="text-foreground">{info.orgName}</strong>
                <Badge>{info.role}</Badge>
              </p>

              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" value={info.email} disabled />
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-name">Your name</Label>
                <Input
                  id="invite-name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Jane Doe"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-password">Password</Label>
                <Input
                  id="invite-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={12}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                Already have an account with this email? Enter your existing password and leave the
                name blank.
              </p>

              {error && <Notice tone="error">{error}</Notice>}

              <Button className="w-full" type="submit" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? "joining…" : "Accept invite"}
              </Button>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={onCancel}
              >
                cancel
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
