#!/usr/bin/env node
/**
 * Seeds a demo organization through the public API.
 *
 *   API_URL=http://localhost:8787 \
 *   EMAIL=demo@opensiel.dev PASSWORD=demo-password-123 \
 *   node scripts/seed-demo.mjs
 *
 * The instance must allow signup (OPENSIEL_ALLOW_SIGNUP=true) unless the account exists.
 */

const base = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const email = process.env.EMAIL ?? "demo@opensiel.dev";
const password = process.env.PASSWORD ?? "demo-password-123";
const orgName = process.env.ORG_NAME ?? "opensiel demo";

async function request(path, { method = "GET", body, token } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = new Error(data?.message ?? `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function login() {
  try {
    const result = await request("/api/auth/signup", {
      method: "POST",
      body: { email, password, name: "Demo User", orgName },
    });
    console.log(`created account ${email}`);
    return result;
  } catch (error) {
    if (error.status !== 403 && error.status !== 409) throw error;
    const result = await request("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    console.log(`logged in as ${email}`);
    return result;
  }
}

function line(step) {
  console.log(`✓ ${step}`);
}

const auth = await login();
const token = auth.token;
const { projects } = await request("/api/projects", { token });
const project = projects[0];

await request(`/api/projects/${project.id}`, {
  method: "PATCH",
  body: { name: "web-app" },
  token,
});
line("project renamed to web-app");

const dev = project.environments.find((environment) => environment.slug === "dev");
const prod = project.environments.find((environment) => environment.slug === "prod");

const secrets = {
  dev: {
    DATABASE_URL: "postgres://app:dev-password@localhost:5432/web_app",
    REDIS_URL: "redis://localhost:6379/0",
    STRIPE_SECRET_KEY: "sk_test_demo_51H8xExampleKey",
    SENTRY_DSN: "https://demo@sentry.example.com/42",
  },
  staging: {
    DATABASE_URL: "postgres://app:staging-password@staging-db:5432/web_app",
    REDIS_URL: "redis://staging-redis:6379/0",
  },
  prod: {
    DATABASE_URL: "postgres://app:prod-password@prod-db:5432/web_app",
    STRIPE_SECRET_KEY: "sk_live_demo_51H8xExampleKey",
  },
};

for (const [slug, values] of Object.entries(secrets)) {
  for (const [key, value] of Object.entries(values)) {
    await request(`/api/projects/${project.id}/secrets`, {
      method: "POST",
      body: { env: slug, key, value, comment: "seed data" },
      token,
    });
  }
}
line("seeded secrets in dev/staging/prod");

await request(`/api/projects/${project.id}/environments/${prod.id}/policy`, {
  method: "PATCH",
  body: { approvalRequired: true, requiredApprovals: 1 },
  token,
});
line("enabled approvals on prod");

await request(`/api/projects/${project.id}/identities`, {
  method: "POST",
  body: { name: "ci-bot", role: "viewer", environmentIds: [dev.id] },
  token,
});
line("created machine identity ci-bot");

await request(`/api/projects/${project.id}/webhooks`, {
  method: "POST",
  body: {
    url: "https://example.com/hooks/opensiel",
    events: ["secret.created", "secret.updated", "change_request.approved"],
  },
  token,
});
line("created sample webhook");

try {
  await request(`/api/projects/${project.id}/secrets`, {
    method: "POST",
    body: {
      env: "prod",
      key: "FEATURE_FLAGS",
      value: "checkout_v2,new_dashboard",
      comment: "enable checkout v2",
    },
    token,
  });
  line("created a pending prod change request");
} catch (error) {
  if (error.status !== 409) throw error;
  console.log("· prod change request left pending");
}

console.log(`\ndone · ${base} · ${email}`);
