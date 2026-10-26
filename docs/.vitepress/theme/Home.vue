<script setup lang="ts">
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Database,
  Fingerprint,
  Github,
  History,
  KeyRound,
  Lock,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Terminal,
  Webhook,
} from "lucide-vue-next";
import { withBase } from "vitepress";

const GITHUB_URL = "https://github.com/ibrahimhnif/opensiel";
const DEMO_URL = "https://opensiel.liostech.id";

const quickstart = `$ cp .env.example .env
$ openssl rand -base64 32   # OPENSIEL_MASTER_KEY
$ docker compose -f deploy/docker-compose.yml up -d --build
$ open http://localhost:8787

$ opensiel init --project web-app --env dev
$ opensiel secrets import .env
$ opensiel run --env dev -- npm run dev`;

const features = [
  {
    icon: History,
    title: "Versioning & rollback",
    body: "Every write is an immutable version. Roll back instantly and keep the full history.",
    link: "/architecture",
  },
  {
    icon: ShieldCheck,
    title: "Approval workflows",
    body: "Require N-of-M approvals before production changes apply. Requesters cannot self-approve.",
    link: "/use-cases#require-approvals-for-production",
  },
  {
    icon: Fingerprint,
    title: "OIDC & SAML SSO",
    body: "Google, Keycloak, Auth0, or any SAML IdP. Invite-based or auto-provisioned orgs.",
    link: "/configuration#oidc",
  },
  {
    icon: Database,
    title: "Dynamic DB credentials",
    body: "Issue short-lived PostgreSQL roles with a TTL and drop them on revoke or expiry.",
    link: "/use-cases#short-lived-database-credentials",
  },
  {
    icon: ScanSearch,
    title: "Secret scanning",
    body: "Check logs or files for stored secrets and common credential patterns. Values stay masked.",
    link: "/use-cases#check-a-log-or-file-for-leaked-secrets",
  },
  {
    icon: Webhook,
    title: "Signed webhooks",
    body: "HMAC-signed event deliveries with retries, status tracking, and no secret values.",
    link: "/use-cases#notify-other-systems",
  },
  {
    icon: Lock,
    title: "External KMS",
    body: "Wrap the master key with AWS KMS and decrypt it once at startup. No key material in env.",
    link: "/configuration#aws-kms",
  },
  {
    icon: ScrollText,
    title: "Audit everything",
    body: "Writes, reads, rollbacks, SSO logins, and lease activity, with values never recorded.",
    link: "/use-cases#audit-access",
  },
];

const checks = ["Approvals", "Versioning", "OIDC + SAML", "Dynamic credentials", "KMS"];

const securityPoints = [
  "AES-256-GCM envelope encryption with per-project data keys",
  "argon2id password hashing and hashed session tokens",
  "Environment-scoped machine identities with 15-minute JWTs",
  "Master key rotation without re-encrypting secrets",
  "Audit log that never stores secret values",
];

const guides = [
  {
    icon: BookOpen,
    title: "Getting started",
    body: "Docker Compose, owner account, invites, and the CLI.",
    link: "/getting-started",
  },
  {
    icon: Terminal,
    title: "Local development",
    body: "Monorepo setup, dev servers, tests, and seeding.",
    link: "/local-development",
  },
  {
    icon: KeyRound,
    title: "Configuration",
    body: "Every environment variable, SSO, KMS, and rotation.",
    link: "/configuration",
  },
  {
    icon: Terminal,
    title: "CLI & SDK",
    body: "Inject secrets into apps and automate reads.",
    link: "/cli",
  },
  {
    icon: ArrowRight,
    title: "CI/CD",
    body: "GitHub Actions and GitLab recipes with machine identities.",
    link: "/ci-cd",
  },
  {
    icon: Database,
    title: "Kubernetes",
    body: "Deploy, TLS, init-container injection, and scaling.",
    link: "/kubernetes",
  },
  {
    icon: ShieldCheck,
    title: "Operations",
    body: "Backups, restore, key rotation, leases, and monitoring.",
    link: "/operations",
  },
  {
    icon: ScanSearch,
    title: "Troubleshooting",
    body: "Common errors, causes, and fixes.",
    link: "/troubleshooting",
  },
];
</script>

<template>
  <div class="os-home">
    <section class="os-hero">
      <div class="os-hero__glow" aria-hidden="true" />
      <div class="os-shell os-hero__grid">
        <div class="os-hero__copy">
          <span class="os-badge">
            <Sparkles class="os-icon os-icon--sm" />
            MIT licensed · self-hosted
          </span>
          <h1>Secrets management <span>without the paywall.</span></h1>
          <p class="os-lede">
            opensiel is a self-hosted secrets manager with approvals, versioning, SSO, dynamic
            database credentials, scanning, and audit logs. Every feature is free, and everything
            runs in one service with PostgreSQL.
          </p>
          <div class="os-actions">
            <a class="os-btn os-btn--brand" :href="withBase('/getting-started')">
              Get started <ArrowRight class="os-icon os-icon--sm" />
            </a>
            <a class="os-btn" :href="GITHUB_URL"> <Github class="os-icon os-icon--sm" /> GitHub </a>
            <a class="os-btn os-btn--ghost" :href="DEMO_URL">
              Live demo <ArrowUpRight class="os-icon os-icon--sm" />
            </a>
          </div>
          <p class="os-demo">
            Demo login: <code>demo@opensiel.dev</code> · <code>demo-password-123</code>
            (read-only)
          </p>
          <div class="os-checks">
            <span v-for="item in checks" :key="item">
              <Check class="os-icon os-icon--sm" /> {{ item }}
            </span>
          </div>
        </div>

        <div class="os-terminal">
          <div class="os-terminal__bar">
            <span class="os-dot os-dot--red" />
            <span class="os-dot os-dot--lime" />
            <span class="os-dot os-dot--muted" />
            <span class="os-terminal__title">
              <Terminal class="os-icon os-icon--sm" /> quickstart
            </span>
          </div>
          <pre><code>{{ quickstart }}</code></pre>
          <div class="os-terminal__footer">
            <span>One service · PostgreSQL · no license server</span>
            <span class="os-accent">v0.1.0</span>
          </div>
        </div>
      </div>
    </section>

    <section class="os-section">
      <div class="os-shell">
        <div class="os-section__head">
          <span class="os-eyebrow">Features</span>
          <h2>The features other tools charge for, included.</h2>
          <p>
            Approvals, versioning, SSO, dynamic credentials, scanning, and audit logs are all part
            of the open-source core.
          </p>
        </div>
        <div class="os-grid os-grid--features">
          <a
            v-for="feature in features"
            :key="feature.title"
            class="os-card"
            :href="withBase(feature.link)"
          >
            <component :is="feature.icon" class="os-icon os-icon--lg" />
            <h3>{{ feature.title }}</h3>
            <p>{{ feature.body }}</p>
          </a>
        </div>
      </div>
    </section>

    <section class="os-section">
      <div class="os-shell">
        <div class="os-section__head">
          <span class="os-eyebrow">Documentation</span>
          <h2>Everything you need to run it.</h2>
          <p>From a first local instance to production pipelines and clusters.</p>
        </div>
        <div class="os-grid os-grid--guides">
          <a
            v-for="guide in guides"
            :key="guide.title"
            class="os-card"
            :href="withBase(guide.link)"
          >
            <component :is="guide.icon" class="os-icon os-icon--lg" />
            <h3>{{ guide.title }}</h3>
            <p>{{ guide.body }}</p>
          </a>
        </div>
      </div>
    </section>

    <section class="os-section">
      <div class="os-shell os-security">
        <div class="os-security__copy">
          <span class="os-eyebrow">Security</span>
          <h2>Encrypted by default, auditable by design.</h2>
          <p>
            A small, readable codebase with a documented crypto model. No hidden service, no
            phone-home licensing.
          </p>
          <ul>
            <li v-for="point in securityPoints" :key="point">
              <Check class="os-icon os-icon--sm" />
              <span>{{ point }}</span>
            </li>
          </ul>
          <a class="os-btn" :href="`${GITHUB_URL}/blob/main/SECURITY.md`">
            Read the security model <ArrowRight class="os-icon os-icon--sm" />
          </a>
        </div>
        <div class="os-keys">
          <div class="os-keys__head">
            <span>Envelope encryption</span>
            <span class="os-pill">AES-256-GCM</span>
          </div>
          <div class="os-key">
            <small>master key (env or AWS KMS)</small>
            <div><span>KEK v1</span><span class="os-accent">rotatable</span></div>
          </div>
          <div class="os-arrow">↓ wraps</div>
          <div class="os-key">
            <small>per-project data key</small>
            <div><span>DEK / project</span><span class="os-accent">rewrapped</span></div>
          </div>
          <div class="os-arrow">↓ encrypts</div>
          <div class="os-key">
            <small>secret versions</small>
            <div><span>v1 · v2 · v3 …</span><span class="os-accent">immutable</span></div>
          </div>
        </div>
      </div>
    </section>

    <section class="os-cta">
      <div class="os-shell os-cta__inner">
        <div>
          <h2>Ready to self-host?</h2>
          <p>One container, PostgreSQL, and a master key. Everything else is optional.</p>
        </div>
        <div class="os-actions">
          <a class="os-btn os-btn--brand" :href="withBase('/getting-started')">
            Start the guide <ArrowRight class="os-icon os-icon--sm" />
          </a>
          <a class="os-btn" :href="GITHUB_URL">
            <Github class="os-icon os-icon--sm" /> View source
          </a>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.os-home {
  color: var(--vp-c-text-1);
}

.os-shell {
  width: 100%;
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px;
}

.os-hero {
  position: relative;
  overflow: hidden;
  border-bottom: 1px solid var(--vp-c-divider);
}

.os-hero__glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(60% 60% at 50% 0%, oklch(88.5% 0.19 116 / 0.13), transparent 70%);
  pointer-events: none;
}

.os-hero__grid {
  position: relative;
  display: grid;
  gap: 48px;
  align-items: center;
  padding-top: 64px;
  padding-bottom: 64px;
}

@media (min-width: 960px) {
  .os-hero__grid {
    grid-template-columns: 1.05fr 0.95fr;
    padding-top: 96px;
    padding-bottom: 96px;
  }
}

.os-hero__copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 22px;
}

.os-badge,
.os-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 30%, transparent);
  background: color-mix(in srgb, var(--vp-c-brand-1) 6%, transparent);
  color: var(--vp-c-brand-1);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
}

.os-hero h1 {
  margin: 0;
  font-size: clamp(2.25rem, 5vw, 3.25rem);
  line-height: 1.05;
  letter-spacing: -0.025em;
  font-weight: 600;
  text-wrap: balance;
}

.os-hero h1 span {
  color: var(--vp-c-brand-1);
}

.os-lede {
  margin: 0;
  max-width: 36rem;
  font-size: 17px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.os-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.os-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--vp-c-border);
  border-radius: 10px;
  padding: 9px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  text-decoration: none;
  transition:
    border-color 0.2s,
    background 0.2s,
    color 0.2s;
}

.os-btn:hover {
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 50%, transparent);
  color: var(--vp-c-text-1);
}

.os-btn--brand {
  border-color: transparent;
  background: var(--vp-c-brand-1);
  color: #16210a;
}

.os-btn--brand:hover {
  background: var(--vp-c-brand-2);
  color: #16210a;
}

.os-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--vp-c-text-2);
}

.os-demo {
  margin: 0;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.os-demo code {
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 11px;
}

.os-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.os-checks span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.os-checks .os-icon {
  color: var(--vp-c-brand-1);
}

.os-terminal {
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--vp-c-bg-soft) 80%, black);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.35);
  overflow: hidden;
}

.os-terminal__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--vp-c-divider);
  padding: 10px 16px;
}

.os-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}

.os-dot--red {
  background: color-mix(in srgb, #ef4444 70%, transparent);
}

.os-dot--lime {
  background: color-mix(in srgb, var(--vp-c-brand-1) 60%, transparent);
}

.os-dot--muted {
  background: var(--vp-c-text-3);
  opacity: 0.5;
}

.os-terminal__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.os-terminal pre {
  margin: 0;
  overflow-x: auto;
  padding: 16px;
  background: transparent;
}

.os-terminal code {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
  background: transparent;
  padding: 0;
}

.os-terminal__footer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  justify-content: space-between;
  border-top: 1px solid var(--vp-c-divider);
  padding: 10px 16px;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.os-section {
  border-bottom: 1px solid var(--vp-c-divider);
  padding: 64px 0;
}

.os-section__head {
  max-width: 42rem;
  margin-bottom: 36px;
}

.os-section__head h2,
.os-security h2,
.os-cta h2 {
  margin: 14px 0 10px;
  font-size: clamp(1.65rem, 3vw, 2rem);
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-weight: 600;
}

.os-section__head p,
.os-security__copy p,
.os-cta p {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

.os-grid {
  display: grid;
  gap: 16px;
}

.os-grid--features {
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
}

.os-grid--guides {
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
}

.os-card {
  display: block;
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--vp-c-bg-soft) 60%, transparent);
  padding: 20px;
  color: inherit;
  text-decoration: none;
  transition:
    border-color 0.2s,
    background 0.2s;
}

.os-card:hover {
  border-color: color-mix(in srgb, var(--vp-c-brand-1) 35%, transparent);
  background: var(--vp-c-bg-soft);
}

.os-card h3 {
  margin: 10px 0 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
}

.os-card p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}

.os-icon {
  color: var(--vp-c-brand-1);
  width: 18px;
  height: 18px;
  flex: none;
}

.os-icon--sm {
  width: 15px;
  height: 15px;
}

.os-icon--lg {
  width: 20px;
  height: 20px;
}

.os-security {
  display: grid;
  gap: 40px;
  align-items: center;
}

@media (min-width: 960px) {
  .os-security {
    grid-template-columns: 1fr 1fr;
  }
}

.os-security__copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
}

.os-security__copy h2,
.os-security__copy p {
  margin: 0;
}

.os-security__copy ul {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.os-security__copy li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}

.os-security__copy li .os-icon {
  margin-top: 3px;
}

.os-keys {
  border: 1px solid var(--vp-c-border);
  border-radius: 12px;
  background: linear-gradient(180deg, var(--vp-c-bg-soft), var(--vp-c-bg));
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.os-keys__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
  font-size: 13.5px;
  font-weight: 500;
}

.os-pill {
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 35%, transparent);
  background: color-mix(in srgb, var(--vp-c-brand-1) 10%, transparent);
  color: var(--vp-c-brand-1);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 11px;
}

.os-key {
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: color-mix(in srgb, var(--vp-c-bg) 65%, transparent);
  padding: 12px 14px;
}

.os-key small {
  display: block;
  margin-bottom: 5px;
  font-size: 11px;
  color: var(--vp-c-text-3);
}

.os-key div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  justify-content: space-between;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
}

.os-arrow {
  padding-left: 16px;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.os-accent {
  color: var(--vp-c-brand-1);
}

.os-cta {
  padding: 56px 0;
}

.os-cta__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}

.os-cta h2 {
  margin-top: 0;
}
</style>
