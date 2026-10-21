import { useState } from "react";
import type { UserDto } from "@opensiel/shared";
import { api, errorMessage } from "../api";

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
          ? await api.post<{ user: UserDto }>("/api/auth/signup", { email, password, name, orgName: orgName || undefined })
          : await api.post<{ user: UserDto }>("/api/auth/login", { email, password });
      onLogin(result.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">◈</span> opensiel
        </div>
        <p className="muted small">self-hosted secrets manager</p>

        {config.oidc?.enabled && (
          <>
            <a className="sso-button" href="/api/auth/oidc/start">
              Continue with {config.oidc.name}
            </a>
            <div className="divider">
              <span>or use your password</span>
            </div>
          </>
        )}

        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={mode === "signup" ? 12 : 1}
          />
        </label>

        {mode === "signup" && (
          <>
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label>
              Organization <span className="muted small">(optional)</span>
              <input value={orgName} onChange={(event) => setOrgName(event.target.value)} />
            </label>
          </>
        )}

        {error && <p className="error">{error}</p>}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? "working…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>

        {config.signupEnabled && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setError("");
            }}
          >
            {mode === "signup" ? "I already have an account" : "Create another account"}
          </button>
        )}

        {mode === "signup" && (
          <p className="muted small">The first account becomes the instance owner. Password: 12+ characters.</p>
        )}
      </form>
    </div>
  );
}
