import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Database,
  Fingerprint,
  History,
  Lock,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Terminal,
  Webhook,
} from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Logo } from "./Logo";
import { GithubIcon } from "./icons";

const GITHUB_URL = "https://github.com/ibrahimhnif/opensiel";
const DEMO_URL = "https://opensiel.liostech.id";

const features = [
  {
    icon: History,
    title: "Versioning & rollback",
    body: "Every write is an immutable version. Roll back instantly and keep the full history.",
  },
  {
    icon: ShieldCheck,
    title: "Approval workflows",
    body: "Require N-of-M approvals before production changes apply. Requester cannot self-approve.",
  },
  {
    icon: Fingerprint,
    title: "OIDC & SAML SSO",
    body: "Bring Google, Keycloak, Auth0, or any SAML IdP. Invite-based or auto-provisioned orgs.",
  },
  {
    icon: Database,
    title: "Dynamic DB credentials",
    body: "Issue short-lived PostgreSQL roles with a TTL and drop them on revoke or expiry.",
  },
  {
    icon: ScanSearch,
    title: "Secret scanning",
    body: "Check logs or files for stored secrets and common credential patterns. Values stay masked.",
  },
  {
    icon: Webhook,
    title: "Signed webhooks",
    body: "HMAC-signed event deliveries with retries, status tracking, and no secret values.",
  },
  {
    icon: Lock,
    title: "External KMS",
    body: "Wrap the master key with AWS KMS and decrypt it once at startup. No key material in env.",
  },
  {
    icon: ScrollText,
    title: "Audit everything",
    body: "Writes, reads, rollbacks, SSO logins, and lease activity, with values never recorded.",
  },
];

const securityPoints = [
  "AES-256-GCM envelope encryption with per-project data keys",
  "argon2id password hashing and hashed session tokens",
  "Environment-scoped machine identities with 15-minute JWTs",
  "Master key rotation without re-encrypting secrets",
  "Audit log that never stores secret values",
];

export function Landing({ authenticated }: { authenticated: boolean }) {
  return (
    <div className="min-h-full bg-background">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link to="/" aria-label="opensiel home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a className="transition-colors hover:text-foreground" href="#features">
              Features
            </a>
            <a className="transition-colors hover:text-foreground" href="#security">
              Security
            </a>
            <a className="transition-colors hover:text-foreground" href="#self-host">
              Self-host
            </a>
            <a
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              href={GITHUB_URL}
            >
              GitHub <ArrowUpRight className="size-3.5" />
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a href={DEMO_URL}>Live demo</a>
            </Button>
            <Button asChild size="sm">
              <Link to={authenticated ? "/app" : "/login"}>
                {authenticated ? "Open app" : "Sign in"}
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,oklch(88.5%_0.19_116/0.13),transparent_70%)]"
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:py-28">
            <div className="space-y-6">
              <Badge
                variant="outline"
                className="gap-1.5 border-primary/30 bg-primary/5 text-primary"
              >
                <Sparkles className="size-3.5" /> MIT licensed · self-hosted
              </Badge>
              <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
                Secrets management <span className="text-primary">without the paywall.</span>
              </h1>
              <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                opensiel is a self-hosted secrets manager with approvals, versioning, SSO, dynamic
                database credentials, scanning, and audit logs. Every feature is free, and
                everything runs in one service with PostgreSQL.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button asChild size="lg">
                  <a href={GITHUB_URL}>
                    <GithubIcon className="size-4" /> Star on GitHub
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <a href={DEMO_URL}>
                    Live demo <ArrowUpRight className="size-4" />
                  </a>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Demo login: <code>demo@opensiel.dev</code> · <code>demo-password-123</code>{" "}
                (read-only)
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                {["Approvals", "Versioning", "OIDC + SAML", "Dynamic credentials", "KMS"].map(
                  (item) => (
                    <span key={item} className="inline-flex items-center gap-1.5">
                      <Check className="size-3.5 text-primary" /> {item}
                    </span>
                  ),
                )}
              </div>
            </div>

            <div className="rounded-xl border bg-card/70 shadow-2xl shadow-black/40">
              <div className="flex items-center gap-1.5 border-b px-4 py-2.5">
                <span className="size-2.5 rounded-full bg-destructive/70" />
                <span className="size-2.5 rounded-full bg-primary/60" />
                <span className="size-2.5 rounded-full bg-muted-foreground/40" />
                <span className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Terminal className="size-3.5" /> quickstart
                </span>
              </div>
              <pre className="overflow-x-auto px-4 py-4 text-xs leading-relaxed text-muted-foreground">
                <code>{`$ cp .env.example .env
$ openssl rand -base64 32   # OPENSIEL_MASTER_KEY
$ docker compose up -d
$ open http://localhost:8787

# then
$ opensiel init --project default --env dev
$ opensiel secrets import .env
$ opensiel run --env dev -- npm run dev`}</code>
              </pre>
              <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
                <span>One service · PostgreSQL · no Redis required for secrets</span>
                <span className="text-primary">v0.1.0</span>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="border-t border-border/60 py-20">
          <div className="mx-auto max-w-6xl space-y-10 px-6">
            <div className="max-w-2xl space-y-3">
              <Badge variant="outline">Features</Badge>
              <h2 className="text-3xl font-semibold tracking-tight">
                The features other tools charge for, included.
              </h2>
              <p className="text-muted-foreground">
                Approvals, versioning, SSO, dynamic credentials, scanning, and audit logs are all
                part of the open-source core.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {features.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-xl border bg-card/60 p-5 transition-colors hover:border-primary/30 hover:bg-card"
                >
                  <feature.icon className="mb-3 size-5 text-primary" />
                  <h3 className="mb-1.5 text-sm font-medium">{feature.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="security" className="border-t border-border/60 py-20">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2 lg:items-center">
            <div className="space-y-5">
              <Badge variant="outline">Security</Badge>
              <h2 className="text-3xl font-semibold tracking-tight">
                Encrypted by default, auditable by design.
              </h2>
              <p className="text-muted-foreground">
                A small, readable codebase with a documented crypto model. No hidden service, no
                phone-home licensing.
              </p>
              <ul className="space-y-3">
                {securityPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span className="text-muted-foreground">{point}</span>
                  </li>
                ))}
              </ul>
              <Button asChild variant="outline" size="sm">
                <a href={`${GITHUB_URL}/blob/main/SECURITY.md`}>
                  Read the security model <ArrowRight className="size-4" />
                </a>
              </Button>
            </div>
            <div className="rounded-xl border bg-gradient-to-b from-muted/40 to-card p-6">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-medium">Envelope encryption</span>
                <Badge variant="success">AES-256-GCM</Badge>
              </div>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border bg-background/60 px-4 py-3">
                  <div className="text-xs text-muted-foreground">master key (env or AWS KMS)</div>
                  <div className="mt-1 flex items-center justify-between font-mono text-xs">
                    <span>KEK v1</span>
                    <span className="text-primary">rotatable</span>
                  </div>
                </div>
                <div className="pl-4 text-muted-foreground">↓ wraps</div>
                <div className="rounded-lg border bg-background/60 px-4 py-3">
                  <div className="text-xs text-muted-foreground">per-project data key</div>
                  <div className="mt-1 flex items-center justify-between font-mono text-xs">
                    <span>DEK / project</span>
                    <span className="text-primary">rewrapped, not re-encrypted</span>
                  </div>
                </div>
                <div className="pl-4 text-muted-foreground">↓ encrypts</div>
                <div className="rounded-lg border bg-background/60 px-4 py-3">
                  <div className="text-xs text-muted-foreground">secret versions</div>
                  <div className="mt-1 flex items-center justify-between font-mono text-xs">
                    <span>v1 · v2 · v3 …</span>
                    <span className="text-primary">immutable</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-border/60 py-20">
          <div className="mx-auto max-w-6xl space-y-8 px-6">
            <div className="max-w-2xl space-y-3">
              <Badge variant="outline">Product</Badge>
              <h2 className="text-3xl font-semibold tracking-tight">
                A UI your team will actually use.
              </h2>
              <p className="text-muted-foreground">
                Projects, environments, secret history, approvals, identities, dynamic credentials,
                webhooks, and audit in one place.
              </p>
            </div>
            <Link
              to={authenticated ? "/app" : "/login"}
              className="group block overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/30 transition-colors hover:border-primary/40"
            >
              <img
                src="/screenshots/dashboard.png"
                alt="opensiel dashboard"
                className="w-full"
                loading="lazy"
              />
              <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  Dashboard, secrets, approvals, and policy in one place
                </span>
                <span className="inline-flex items-center gap-1 text-primary">
                  Open app <ArrowRight className="size-4" />
                </span>
              </div>
            </Link>
          </div>
        </section>

        <section id="self-host" className="border-t border-border/60 py-20">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2">
            <div className="space-y-5">
              <Badge variant="outline">Self-host</Badge>
              <h2 className="text-3xl font-semibold tracking-tight">
                Running in minutes, yours forever.
              </h2>
              <p className="text-muted-foreground">
                One container and PostgreSQL. Kubernetes manifests and a production image are
                included, with optional SSO, KMS, and dynamic credentials.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button asChild>
                  <a href={`${GITHUB_URL}#quickstart`}>
                    <GithubIcon className="size-4" /> View on GitHub
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a href={DEMO_URL}>Try the demo</a>
                </Button>
              </div>
            </div>
            <div className="rounded-xl border bg-card/60 p-5">
              <ol className="space-y-4 text-sm">
                {[
                  ["Clone and configure", "cp .env.example .env, then set the two secrets."],
                  ["Start the stack", "docker compose -f deploy/docker-compose.yml up -d --build"],
                  ["Create the owner", "Open the app; the first signup becomes the owner."],
                  ["Connect your app", "opensiel run --env dev -- npm run dev"],
                ].map(([title, body], index) => (
                  <li key={title} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-xs font-medium text-primary">
                      {index + 1}
                    </span>
                    <div>
                      <div className="font-medium">{title}</div>
                      <div className="text-muted-foreground">{body}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 sm:flex-row">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Logo className="text-sm" />
            <span>·</span>
            <span>MIT licensed</span>
          </div>
          <div className="flex items-center gap-5 text-sm text-muted-foreground">
            <a className="hover:text-foreground" href={GITHUB_URL}>
              GitHub
            </a>
            <a className="hover:text-foreground" href={`${GITHUB_URL}#readme`}>
              Docs
            </a>
            <a className="hover:text-foreground" href={DEMO_URL}>
              Demo
            </a>
            <Link className="hover:text-foreground" to={authenticated ? "/app" : "/login"}>
              {authenticated ? "Open app" : "Sign in"}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
