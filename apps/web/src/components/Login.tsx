import { useState } from "react";
import { Link } from "react-router-dom";
import type { UserDto } from "@opensiel/shared";
import { Fingerprint, History, Loader2, ShieldCheck } from "lucide-react";
import QRCode from "react-qr-code";
import { ApiError, api, errorMessage } from "../api";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Logo } from "./Logo";
import { Notice } from "./Notice";

interface Props {
  config: {
    initialized: boolean;
    signupEnabled: boolean;
    oidc?: { enabled: boolean; name: string };
    saml?: { enabled: boolean; name: string };
  };
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
  const [mfaChallenge, setMfaChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [enrollment, setEnrollment] = useState<{
    token: string;
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") {
        const result = await api.post<{ user: UserDto }>("/api/auth/signup", {
          email,
          password,
          name,
          orgName: orgName || undefined,
        });
        onLogin(result.user);
        return;
      }

      const result = await api.post<{
        user?: UserDto;
        token?: string;
        mfaRequired?: boolean;
        challengeToken?: string;
      }>("/api/auth/login", { email, password });

      if (result.mfaRequired && result.challengeToken) {
        setMfaChallenge(result.challengeToken);
        setMfaCode("");
        return;
      }
      if (result.user) onLogin(result.user);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; enrollmentToken?: string } | undefined;
        if (body?.error === "mfa_enrollment_required" && body.enrollmentToken) {
          try {
            const setup = await api.post<{ secret: string; otpauthUrl: string }>(
              "/api/auth/mfa/setup",
              { enrollmentToken: body.enrollmentToken },
            );
            setEnrollment({ token: body.enrollmentToken, ...setup });
            setEnrollCode("");
            return;
          } catch (setupError) {
            setError(errorMessage(setupError));
            return;
          }
        }
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function completeMfa(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ user: UserDto }>("/api/auth/mfa/login", {
        challengeToken: mfaChallenge,
        code: mfaCode,
      });
      onLogin(result.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function completeEnrollment(event: React.FormEvent) {
    event.preventDefault();
    if (!enrollment) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.post<{ user: UserDto }>("/api/auth/mfa/verify", {
        enrollmentToken: enrollment.token,
        code: enrollCode,
      });
      onLogin(result.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <aside className="hidden flex-col justify-between border-r bg-sidebar p-10 lg:flex">
        <Link to="/" aria-label="opensiel home">
          <Logo />
        </Link>
        <div className="space-y-6">
          <h1 className="max-w-sm text-3xl font-semibold tracking-tight text-balance">
            Every secret. One place. No paywall.
          </h1>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            opensiel keeps application secrets encrypted, versioned, and auditable, with the
            workflows other tools put behind an enterprise plan.
          </p>
          <ul className="space-y-4 text-sm">
            <li className="flex items-start gap-3">
              <History className="mt-0.5 size-4 text-primary" />
              <span>
                <span className="font-medium">Immutable versions</span>
                <span className="block text-muted-foreground">
                  Roll back any secret with a full history.
                </span>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-4 text-primary" />
              <span>
                <span className="font-medium">Approvals before production</span>
                <span className="block text-muted-foreground">
                  Require N-of-M approvals for sensitive environments.
                </span>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Fingerprint className="mt-0.5 size-4 text-primary" />
              <span>
                <span className="font-medium">SSO that is included</span>
                <span className="block text-muted-foreground">
                  OIDC and SAML with invite-based provisioning.
                </span>
              </span>
            </li>
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">MIT licensed · self-hosted</p>
      </aside>

      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-5">
          <div className="lg:hidden">
            <Link to="/" aria-label="opensiel home">
              <Logo />
            </Link>
          </div>

          <Card className="gap-4">
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {mode === "signup" ? "Create your account" : "Sign in to your instance"}
              </p>

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

              {config.saml?.enabled && (
                <>
                  <Button asChild className="w-full">
                    <a href="/api/auth/saml/start">Continue with SAML ({config.saml.name})</a>
                  </Button>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    <span>or use your password</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                </>
              )}

              {mfaChallenge ? (
                <form className="space-y-4" onSubmit={completeMfa}>
                  <div className="space-y-2">
                    <Label htmlFor="mfa-code">Authentication code</Label>
                    <Input
                      id="mfa-code"
                      autoComplete="one-time-code"
                      autoCapitalize="characters"
                      autoFocus
                      value={mfaCode}
                      onChange={(event) => setMfaCode(event.target.value)}
                      placeholder="123456"
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter the 6-digit code from your authenticator, or a recovery code.
                    </p>
                  </div>
                  <Button className="w-full" type="submit" disabled={busy}>
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {busy ? "verifying…" : "verify"}
                  </Button>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() => {
                      setMfaChallenge("");
                      setMfaCode("");
                      setError("");
                    }}
                  >
                    back to password
                  </Button>
                </form>
              ) : enrollment ? (
                <form className="space-y-4" onSubmit={completeEnrollment}>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Set up an authenticator</p>
                    <p className="text-xs text-muted-foreground">
                      This organization requires MFA. Scan the code and enter the 6-digit code to
                      finish signing in.
                    </p>
                  </div>
                  <div className="flex justify-center rounded-lg bg-white p-3">
                    <QRCode value={enrollment.otpauthUrl} size={160} />
                  </div>
                  <div className="space-y-1">
                    <Label>Manual secret</Label>
                    <code className="block rounded bg-muted px-2 py-1 text-xs break-all">
                      {enrollment.secret}
                    </code>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="enroll-code">Code</Label>
                    <Input
                      id="enroll-code"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      autoFocus
                      value={enrollCode}
                      onChange={(event) => setEnrollCode(event.target.value)}
                      required
                    />
                  </div>
                  <Button className="w-full" type="submit" disabled={busy}>
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {busy ? "verifying…" : "enable MFA and sign in"}
                  </Button>
                </form>
              ) : (
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
                          Organization{" "}
                          <span className="font-normal text-muted-foreground">(optional)</span>
                        </Label>
                        <Input
                          id="orgName"
                          value={orgName}
                          onChange={(event) => setOrgName(event.target.value)}
                        />
                      </div>
                    </>
                  )}

                  <Button className="w-full" type="submit" disabled={busy}>
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {busy ? "working…" : mode === "signup" ? "Create account" : "Sign in"}
                  </Button>
                </form>
              )}

              {error && <Notice tone="error">{error}</Notice>}

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

          <p className="text-center text-xs text-muted-foreground">
            <Link to="/" className="transition-colors hover:text-foreground">
              ← Back to home
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
