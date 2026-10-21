import { useEffect, useState } from "react";
import type { InviteInfoDto, UserDto } from "@opensiel/shared";
import { api, errorMessage } from "../api";

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

  if (!info && !error) return <div className="center muted">loading invite…</div>;

  if (!info) {
    return (
      <div className="center">
        <div className="card narrow">
          <div className="brand">
            <span className="brand-mark">◈</span> opensiel
          </div>
          <h2>Invite unavailable</h2>
          <p className="error">{error}</p>
          <button className="link" onClick={onCancel}>
            back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">◈</span> opensiel
        </div>
        <p className="muted small">
          Join <strong>{info.orgName}</strong> as <span className="pill">{info.role}</span>
        </p>

        <label>
          Email
          <input value={info.email} disabled />
        </label>

        <label>
          Your name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Jane Doe"
          />
        </label>

        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={12}
          />
        </label>

        <p className="muted small">
          Already have an account with this email? Enter your existing password and leave the
          name blank.
        </p>

        {error && <p className="error">{error}</p>}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? "joining…" : "Accept invite"}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          cancel
        </button>
      </form>
    </div>
  );
}
