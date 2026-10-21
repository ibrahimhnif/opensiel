import { useEffect, useState } from "react";
import type { UserDto } from "@opensiel/shared";
import { api, errorMessage } from "./api";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";

interface BootstrapConfig {
  initialized: boolean;
  signupEnabled: boolean;
  version: string;
}

export function App() {
  const [config, setConfig] = useState<BootstrapConfig | null>(null);
  const [user, setUser] = useState<UserDto | null>(null);
  const [error, setError] = useState("");

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
    return <Login config={config} onLogin={setUser} />;
  }

  return <Dashboard user={user} onSignedOut={() => setUser(null)} />;
}
