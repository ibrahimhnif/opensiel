import { useState } from "react";
import type { UserDto } from "@opensiel/shared";
import { Diamond, Loader2 } from "lucide-react";
import { api, errorMessage } from "../api";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Notice } from "./Notice";

interface Props {
  config: { initialized: boolean; signupEnabled: boolean; oidc?: { enabled: boolean; name: string } };
  onLogin: (user: UserDto) => void;
  initialError?: string;
}

export function Login({ config, onLogin, initialError }: Props) {
  const [mode, setMode] = useState<"login" | "signup">(config.initialized ? "login" : "signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "signup"
          ? await api.post<{ user: UserDto }>("/api/auth/signup", {
              email,
              password,
              name,
              orgName: orgName || undefined,
            })
          : await api.post<{ user: UserDto }>("/api/auth/login", { email, password });
      onLogin(result.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center justify-center gap-2 text-xl font-semibold tracking-tight">
          <Diamond className="size-5 text-primary" />
          opensiel
        </div>

        <Card className="gap-4">
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">self-hosted secrets manager</p>

            {config.oidc?.enabled && (
              <>
                <Button asChild className="w-full">
                  <a href="/api/auth/oidc/start">Continue with {config.oidc.name}</a>
                </Button>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <span>or use your password</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={mode === "signup" ? 12 : 1}
                />
              </div>

              {mode === "signup" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="orgName">
                      Organization <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="orgName"
                      value={orgName}
                      onChange={(event) => setOrgName(event.target.value)}
                    />
                  </div>
                </>
              )}

              {error && <Notice tone="error">{error}</Notice>}

              <Button className="w-full" type="submit" disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? "working…" : mode === "signup" ? "Create account" : "Sign in"}
              </Button>
            </form>

            {config.signupEnabled && (
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => {
                  setMode(mode === "signup" ? "login" : "signup");
                  setError("");
                }}
              >
                {mode === "signup" ? "I already have an account" : "Create another account"}
              </Button>
            )}

            {mode === "signup" && (
              <p className="text-xs text-muted-foreground">
                The first account becomes the instance owner. Password: 12+ characters.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
