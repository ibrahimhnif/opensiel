import { useEffect, useState } from "react";
import type { UserDto } from "@opensiel/shared";
import { api, errorMessage } from "./api";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";
import { AcceptInvite } from "./components/AcceptInvite";

interface BootstrapConfig {
  initialized: boolean;
  signupEnabled: boolean;
  version: string;
  oidc?: { enabled: boolean; name: string };
}

export function App() {
  const [config, setConfig] = useState<BootstrapConfig | null>(null);
  const [user, setUser] = useState<UserDto | null>(null);
  const [error, setError] = useState("");
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("invite"),
  );
  const [ssoError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("sso_error"),
  );

  function clearInvite() {
    window.history.replaceState({}, "", window.location.pathname);
    setInviteToken(null);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bootstrap = await api.get<BootstrapConfig>("/api/auth/config");
        if (cancelled) return;
        setConfig(bootstrap);
        try {
          const me = await api.get<{ user: UserDto }>("/api/auth/me");
          if (!cancelled) setUser(me.user);
        } catch {
          /* not logged in */
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (inviteToken) {
    return (
      <AcceptInvite
        token={inviteToken}
        onDone={(nextUser) => {
          clearInvite();
          setUser(nextUser);
        }}
        onCancel={clearInvite}
      />
    );
  }

  if (error) {
    return (
      <div className="center">
        <div className="card narrow">
          <h2>opensiel</h2>
          <p className="error">{error}</p>
          <p className="muted">The API is unreachable. Check that the server is running.</p>
        </div>
      </div>
    );
  }

  if (!config) return <div className="center muted">loading…</div>;

  if (!user) {
    return <Login config={config} onLogin={setUser} initialError={ssoError ?? undefined} />;
  }

  return <Dashboard user={user} onSignedOut={() => setUser(null)} />;
}
