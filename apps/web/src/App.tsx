import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { UserDto } from "@opensiel/shared";
import { Loader2 } from "lucide-react";
import { api, errorMessage } from "./api";
import { Card, CardContent } from "./components/ui/card";
import { Landing } from "./components/Landing";
import { Login } from "./components/Login";
import { Dashboard } from "./components/Dashboard";
import { AcceptInvite } from "./components/AcceptInvite";

interface BootstrapConfig {
  initialized: boolean;
  signupEnabled: boolean;
  version: string;
  oidc?: { enabled: boolean; name: string };
  saml?: { enabled: boolean; name: string };
}

const TITLES: Record<string, string> = {
  "/": "opensiel — self-hosted secrets manager",
  "/login": "Sign in · opensiel",
  "/app": "opensiel",
  "/invite": "Join an organization · opensiel",
};

export function App() {
  const [config, setConfig] = useState<BootstrapConfig | null>(null);
  const [user, setUser] = useState<UserDto | null>(null);
  const [error, setError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();

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

  useEffect(() => {
    document.title = TITLES[location.pathname] ?? "opensiel";
  }, [location.pathname]);

  if (error) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <Card className="w-full max-w-sm gap-3">
          <CardContent className="space-y-2">
            <h1 className="text-lg font-semibold">opensiel</h1>
            <p className="text-sm text-destructive">{error}</p>
            <p className="text-sm text-muted-foreground">
              The API is unreachable. Check that the server is running.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> loading…
        </span>
      </div>
    );
  }

  const params = new URLSearchParams(location.search);
  const inviteToken = params.get("invite");
  const acceptToken = params.get("token") ?? inviteToken;
  const ssoError = params.get("sso_error") ?? undefined;

  return (
    <Routes>
      <Route
        path="/"
        element={
          inviteToken ? (
            <Navigate to={`/invite?token=${encodeURIComponent(inviteToken)}`} replace />
          ) : (
            <Landing authenticated={Boolean(user)} />
          )
        }
      />
      <Route
        path="/login"
        element={
          user ? (
            <Navigate to="/app" replace />
          ) : (
            <Login
              config={config}
              initialError={ssoError}
              onLogin={(nextUser) => {
                setUser(nextUser);
                navigate("/app", { replace: true });
              }}
            />
          )
        }
      />
      <Route
        path="/app"
        element={
          user ? (
            <Dashboard
              user={user}
              onSignedOut={() => {
                setUser(null);
                navigate("/", { replace: true });
              }}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/invite"
        element={
          acceptToken ? (
            <AcceptInvite
              token={acceptToken}
              onDone={(nextUser) => {
                setUser(nextUser);
                navigate("/app", { replace: true });
              }}
              onCancel={() => navigate("/")}
            />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="*" element={<Landing authenticated={Boolean(user)} />} />
    </Routes>
  );
}
