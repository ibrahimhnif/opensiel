import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignedXml } from "xml-crypto";
import { SAML_CERT, SAML_KEY } from "./fixtures/saml.js";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import type { Database } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { generateMasterKey, parseMasterKey } from "../src/crypto.js";
import type { Env } from "../src/env.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  describe.skip("api integration (set TEST_DATABASE_URL)", () => {
    it("skipped", () => undefined);
  });
} else {
  const env: Env = {
    nodeEnv: "test",
    port: 0,
    host: "127.0.0.1",
    databaseUrl,
    masterKey: parseMasterKey(generateMasterKey()),
    masterKeyVersion: 1,
    jwtSecret: "test-secret-that-is-long-enough-for-hs256",
    allowSignup: true,
    autoMigrate: true,
    rateLimit: false,
    isProd: false,
    secureCookies: false,
  };

  let app: FastifyInstance;
  let database: Database;
  let idp: FastifyInstance;
  let idpIssuer = "";
  let idpEmail = "";
  let idpName = "";
  let idpPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let idpJwk: Record<string, unknown>;
  const idpCodes = new Map<string, { nonce: string; email: string; name: string }>();

  let hookReceiver: FastifyInstance;
  let hookUrl = "";
  interface ReceivedHook {
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }
  const hookQueue: ReceivedHook[] = [];
  const hookWaiters: ((hook: ReceivedHook) => void)[] = [];

  function nextHook(timeoutMs = 3000): Promise<ReceivedHook> {
    const queued = hookQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a webhook")), timeoutMs);
      hookWaiters.push((hook) => {
        clearTimeout(timer);
        resolve(hook);
      });
    });
  }

  function cookieValue(
    header: string | string[] | undefined,
    name: string,
  ): string | null {
    const entries = Array.isArray(header) ? header : header ? [header] : [];
    for (const entry of entries) {
      const [pair] = entry.split(";");
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      if (pair.slice(0, separator).trim() === name) {
        return decodeURIComponent(pair.slice(separator + 1));
      }
    }
    return null;
  }

  async function startSso(
    email: string,
    name = "SSO User",
  ): Promise<{ callbackPath: string; cookie: string }> {
    idpEmail = email;
    idpName = name;

    const start = await app.inject({ method: "GET", url: "/api/auth/oidc/start" });
    expect(start.statusCode).toBe(302);
    const location = start.headers.location as string;
    expect(location).toBeTruthy();

    const cookie = cookieValue(start.headers["set-cookie"], "opensiel_oidc");
    expect(cookie).toBeTruthy();

    const authorize = await fetch(location, { redirect: "manual" });
    const redirect = authorize.headers.get("location");
    expect(redirect).toBeTruthy();
    const callback = new URL(redirect!);

    return { callbackPath: `${callback.pathname}${callback.search}`, cookie: cookie! };
  }

  function finishSso(callbackPath: string, cookie: string) {
    return app.inject({
      method: "GET",
      url: callbackPath,
      headers: { cookie: `opensiel_oidc=${encodeURIComponent(cookie)}` },
    });
  }

  async function ssoLogin(email: string, name = "SSO User") {
    const { callbackPath, cookie } = await startSso(email, name);
    const response = await finishSso(callbackPath, cookie);
    expect(response.statusCode).toBe(302);
    const session = cookieValue(response.headers["set-cookie"], "opensiel_session");
    if (!session) throw new Error(`SSO login failed: ${response.headers.location}`);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(me.statusCode).toBe(200);
    return {
      token: session,
      user: me.json<{ user: { id: string; email: string; role: string; orgId: string } }>().user,
    };
  }

  function buildSamlResponse(email: string, name: string): string {
    const now = new Date();
    const notBefore = new Date(now.getTime() - 60_000).toISOString();
    const notOnOrAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
    const issueInstant = now.toISOString();
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${issueInstant}" Destination="http://localhost:8787/api/auth/saml/callback">
  <saml:Issuer>https://idp.test</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${issueInstant}">
    <saml:Issuer>https://idp.test</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="http://localhost:8787/api/auth/saml/callback"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml:AudienceRestriction><saml:Audience>opensiel</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="name"><saml:AttributeValue>${name}</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;

    const signer = new SignedXml({ privateKey: SAML_KEY, publicCert: SAML_CERT });
    signer.addReference({
      xpath: "/*[local-name()='Response']/*[local-name()='Assertion']",
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
    });
    signer.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
    signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    signer.computeSignature(xml, {
      prefix: "ds",
      location: {
        reference:
          "/*[local-name()='Response']/*[local-name()='Assertion']/*[local-name()='Issuer']",
        action: "after",
      },
    });
    return signer.getSignedXml();
  }

  async function samlLogin(email: string, name = "SAML User") {
    const xml = buildSamlResponse(email, name);
    const form = new URLSearchParams({
      SAMLResponse: Buffer.from(xml).toString("base64"),
    }).toString();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form,
    });
    expect(response.statusCode).toBe(302);
    const session = cookieValue(response.headers["set-cookie"], "opensiel_session");
    if (!session) throw new Error(`SAML login failed: ${response.headers.location}`);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(me.statusCode).toBe(200);
    return {
      token: session,
      user: me.json<{ user: { id: string; email: string; role: string; orgId: string } }>().user,
    };
  }

  interface Session {
    token: string;
    projectId: string;
    devId: string;
    stagingId: string;
    prodId: string;
  }

  async function signup(email: string): Promise<Session> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct-horse-battery", name: "Test User" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ token: string; projectId: string }>();
    const projects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${body.token}` },
    });
    const project = projects.json<{
      projects: { id: string; environments: { id: string; slug: string }[] }[];
    }>().projects[0];
    return {
      token: body.token,
      projectId: body.projectId,
      devId: project.environments.find((e) => e.slug === "dev")!.id,
      stagingId: project.environments.find((e) => e.slug === "staging")!.id,
      prodId: project.environments.find((e) => e.slug === "prod")!.id,
    };
  }

  async function inviteAndAccept(
    ownerToken: string,
    email: string,
    role: "admin" | "member" | "viewer",
  ): Promise<{ token: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email, role },
    });
    expect(created.statusCode).toBe(201);
    const inviteToken = created.json<{ token: string }>().token;
    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token: inviteToken, name: role, password: "correct-horse-battery" },
    });
    expect(accepted.statusCode).toBe(201);
    return { token: accepted.json<{ token: string }>().token };
  }

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    idpPrivateKey = keys.privateKey;
    idpJwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    };

    idp = Fastify();
    idp.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (error) {
          done(error as Error);
        }
      },
    );
    idp.get("/.well-known/openid-configuration", async () => ({
      issuer: idpIssuer,
      authorization_endpoint: `${idpIssuer}/authorize`,
      token_endpoint: `${idpIssuer}/token`,
      jwks_uri: `${idpIssuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    }));
    idp.get("/authorize", async (request, reply) => {
      const query = request.query as Record<string, string>;
      if (
        query.client_id !== "test-client" ||
        query.code_challenge_method !== "S256" ||
        !query.code_challenge
      ) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const code = `code-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      idpCodes.set(code, { nonce: query.nonce, email: idpEmail, name: idpName });
      const url = new URL(query.redirect_uri);
      url.searchParams.set("code", code);
      url.searchParams.set("state", query.state);
      return reply.redirect(url.toString());
    });
    idp.get("/jwks", async () => ({ keys: [idpJwk] }));
    idp.post("/token", async (request, reply) => {
      const body = request.body as Record<string, string>;
      if (body.client_id !== "test-client" || body.client_secret !== "test-secret") {
        return reply.code(401).send({ error: "invalid_client" });
      }
      const entry = idpCodes.get(body.code);
      if (!entry) return reply.code(400).send({ error: "invalid_grant" });
      idpCodes.delete(body.code);

      const idToken = await new SignJWT({
        email: entry.email,
        email_verified: true,
        name: entry.name,
        nonce: entry.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(idpIssuer)
        .setAudience("test-client")
        .setSubject(`sub-${entry.email}`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(idpPrivateKey);

      return {
        id_token: idToken,
        token_type: "Bearer",
        access_token: "test-access-token",
        expires_in: 300,
      };
    });

    await idp.listen({ port: 0, host: "127.0.0.1" });
    const address = idp.server.address();
    const idpPort = typeof address === "object" && address ? address.port : 0;
    idpIssuer = `http://127.0.0.1:${idpPort}`;

    hookReceiver = Fastify();
    hookReceiver.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
    hookReceiver.post("/hook", async (request, reply) => {
      const received: ReceivedHook = {
        headers: request.headers,
        body: request.body as string,
      };
      const waiter = hookWaiters.shift();
      if (waiter) waiter(received);
      else hookQueue.push(received);
      return reply.code(200).send({ ok: true });
    });
    await hookReceiver.listen({ port: 0, host: "127.0.0.1" });
    const hookAddress = hookReceiver.server.address();
    const hookPort = typeof hookAddress === "object" && hookAddress ? hookAddress.port : 0;
    hookUrl = `http://127.0.0.1:${hookPort}/hook`;

    env.oidc = {
      issuer: idpIssuer,
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "http://localhost:8787/api/auth/oidc/callback",
      scopes: "openid email profile",
      allowedDomains: [],
      autoCreate: true,
    };
    env.saml = {
      entryPoint: "https://idp.test/sso",
      issuer: "opensiel",
      idpCert: SAML_CERT,
      callbackUrl: "http://localhost:8787/api/auth/saml/callback",
      audience: "opensiel",
      allowedDomains: [],
      autoCreate: true,
    };

    database = createDb(databaseUrl, { max: 5 });
    await database.sql.unsafe("drop schema if exists public cascade");
    await database.sql.unsafe("create schema public");
    await runMigrations(database.sql);
    app = await buildApp({ env, db: database.db, sql: database.sql });
  });

  afterAll(async () => {
    await app.close();
    await idp.close();
    await hookReceiver.close();
    await database.sql.end({ timeout: 5 });
  });

  it("reports health", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe("ok");
  });

  it("signs up, logs in, and rejects bad passwords", async () => {
    const session = await signup(`owner-${Date.now()}@test.dev`);
    expect(session.token).toBeTruthy();

    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nope@test.dev", password: "whatever" },
    });
    expect(bad.statusCode).toBe(401);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("versions secrets and rolls them back", async () => {
    const session = await signup(`versions-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}/secrets`;

    const v1 = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { key: "DATABASE_URL", value: "v1", env: "dev", comment: "first" },
    });
    expect(v1.statusCode).toBe(201);
    expect(v1.json<{ secret: { version: number } }>().secret.version).toBe(1);

    const v2 = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { key: "DATABASE_URL", value: "v2", env: "dev" },
    });
    expect(v2.json<{ secret: { version: number } }>().secret.version).toBe(2);

    const latest = await app.inject({ method: "GET", url: `${base}/DATABASE_URL?env=dev`, headers: auth });
    expect(latest.json<{ secret: { value: string } }>().secret.value).toBe("v2");

    const versions = await app.inject({
      method: "GET",
      url: `${base}/DATABASE_URL/versions?env=dev`,
      headers: auth,
    });
    expect(versions.json<{ versions: unknown[] }>().versions).toHaveLength(2);

    const rollback = await app.inject({
      method: "POST",
      url: `${base}/DATABASE_URL/rollback`,
      headers: auth,
      payload: { version: 1, env: "dev" },
    });
    expect(rollback.statusCode).toBe(201);
    expect(rollback.json<{ secret: { version: number } }>().secret.version).toBe(3);

    const after = await app.inject({ method: "GET", url: `${base}/DATABASE_URL?env=dev`, headers: auth });
    expect(after.json<{ secret: { value: string } }>().secret.value).toBe("v1");

    const exported = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/export?env=dev&format=dotenv`,
      headers: auth,
    });
    expect(exported.body).toContain("DATABASE_URL=v1");
  });

  it("isolates organizations", async () => {
    const a = await signup(`org-a-${Date.now()}@test.dev`);
    const b = await signup(`org-b-${Date.now()}@test.dev`);

    const bProjects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(bProjects.json<{ projects: unknown[] }>().projects).toHaveLength(1);

    const cross = await app.inject({
      method: "GET",
      url: `/api/projects/${a.projectId}/secrets?env=dev`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(cross.statusCode).toBe(404);
  });

  it("scopes machine identities to environments and roles", async () => {
    const session = await signup(`machine-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/identities`,
      headers: auth,
      payload: { name: "ci", role: "viewer", environmentIds: [session.devId] },
    });
    expect(created.statusCode).toBe(201);
    const identity = created.json<{ identity: { id: string; clientId: string; clientSecret: string } }>()
      .identity;

    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: { clientId: identity.clientId, clientSecret: identity.clientSecret },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const machineToken = tokenResponse.json<{ accessToken: string }>().accessToken;

    const devRead = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/secrets?env=dev`,
      headers: { authorization: `Bearer ${machineToken}` },
    });
    expect(devRead.statusCode).toBe(200);

    const prodRead = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/secrets?env=prod`,
      headers: { authorization: `Bearer ${machineToken}` },
    });
    expect(prodRead.statusCode).toBe(403);

    const write = await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/secrets`,
      headers: { authorization: `Bearer ${machineToken}` },
      payload: { key: "NOPE", value: "x", env: "dev" },
    });
    expect(write.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/identities/${identity.id}/revoke`,
      headers: auth,
    });
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: { clientId: identity.clientId, clientSecret: identity.clientSecret },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("resolves secret references and leaves cycles alone", async () => {
    const session = await signup(`refs-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const url = `/api/projects/${session.projectId}/secrets`;

    const set = async (key: string, value: string, path?: string) => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: auth,
        payload: { key, value, env: "dev", path },
      });
      expect(response.statusCode).toBe(201);
    };

    await set("FOO", "bar");
    await set("DB_URL", "postgres://${FOO}@host");
    await set("TOKEN", "tok", "/backend");
    await set("NESTED", "${/backend/TOKEN}-x");
    await set("A", "${B}");
    await set("B", "${A}");
    await set("LITERAL", "\\${FOO}");
    await set("MISSING", "${DOES_NOT_EXIST}");

    const list = await app.inject({ method: "GET", url: `${url}?env=dev`, headers: auth });
    const values = Object.fromEntries(
      list.json<{ secrets: { key: string; value: string }[] }>().secrets.map((row) => [
        row.key,
        row.value,
      ]),
    );

    expect(values.DB_URL).toBe("postgres://bar@host");
    expect(values.NESTED).toBe("tok-x");
    expect(values.A).toBe("${B}");
    expect(values.B).toBe("${A}");
    expect(values.LITERAL).toBe("${FOO}");
    expect(values.MISSING).toBe("${DOES_NOT_EXIST}");

    const single = await app.inject({
      method: "GET",
      url: `${url}/DB_URL?env=dev`,
      headers: auth,
    });
    expect(single.json<{ secret: { value: string } }>().secret.value).toBe("postgres://bar@host");
  });

  it("imports secrets from another environment", async () => {
    const session = await signup(`imports-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const url = `/api/projects/${session.projectId}/secrets`;

    const set = async (env: string, key: string, value: string) => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: auth,
        payload: { key, value, env },
      });
      expect(response.statusCode).toBe(201);
    };

    await set("dev", "FOO", "devvalue");
    await set("dev", "SHARED", "from-dev");

    const linked = await app.inject({
      method: "PUT",
      url: `/api/projects/${session.projectId}/environments/${session.stagingId}/imports`,
      headers: auth,
      payload: { sourceEnvironmentId: session.devId },
    });
    expect(linked.statusCode).toBe(200);

    await set("staging", "SHARED", "from-staging");

    const staging = await app.inject({
      method: "GET",
      url: `${url}?env=staging`,
      headers: auth,
    });
    const rows = staging.json<{
      secrets: { key: string; value: string; importedFrom?: string }[];
    }>().secrets;
    const foo = rows.find((row) => row.key === "FOO");
    const shared = rows.find((row) => row.key === "SHARED");
    expect(foo).toMatchObject({ value: "devvalue", importedFrom: "dev" });
    expect(shared).toMatchObject({ value: "from-staging" });
    expect(shared?.importedFrom).toBeUndefined();

    const importsList = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/environment-imports`,
      headers: auth,
    });
    expect(importsList.statusCode).toBe(200);
    expect(
      importsList.json<{ imports: { targetEnvironmentId: string }[] }>().imports,
    ).toHaveLength(1);

    const identity = await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/identities`,
      headers: auth,
      payload: { name: "staging-reader", role: "viewer", environmentIds: [session.stagingId] },
    });
    const created = identity.json<{ identity: { clientId: string; clientSecret: string } }>().identity;
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: { clientId: created.clientId, clientSecret: created.clientSecret },
    });
    const machineToken = tokenResponse.json<{ accessToken: string }>().accessToken;

    const machineView = await app.inject({
      method: "GET",
      url: `${url}?env=staging`,
      headers: { authorization: `Bearer ${machineToken}` },
    });
    const machineRows = machineView.json<{ secrets: { key: string }[] }>().secrets;
    expect(machineRows.find((row) => row.key === "SHARED")).toBeTruthy();
    expect(machineRows.find((row) => row.key === "FOO")).toBeUndefined();
  });

  it("bulk imports .env content and JSON", async () => {
    const session = await signup(`import-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const url = `/api/projects/${session.projectId}/secrets`;

    const contents = [
      "# seeded",
      "FOO=bar",
      'export QUOTED="a b"',
      'NEWLINE="line1\\nline2"',
    ].join("\n");

    const dryRun = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: auth,
      payload: { env: "dev", contents, dryRun: true },
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json<{ keys: string[] }>().keys).toEqual(["FOO", "QUOTED", "NEWLINE"]);

    const hidden = await app.inject({ method: "GET", url: `${url}?env=dev`, headers: auth });
    expect(hidden.json<{ secrets: unknown[] }>().secrets).toHaveLength(0);

    const imported = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: auth,
      payload: { env: "dev", contents, comment: "seed" },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json<{ created: number; updated: number }>()).toMatchObject({
      created: 3,
      updated: 0,
    });

    const again = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: auth,
      payload: { env: "dev", contents: "FOO=updated\nNEW_KEY=1" },
    });
    expect(again.json<{ created: number; updated: number }>()).toMatchObject({
      created: 1,
      updated: 1,
    });

    const list = await app.inject({ method: "GET", url: `${url}?env=dev`, headers: auth });
    const values = Object.fromEntries(
      list.json<{ secrets: { key: string; value: string }[] }>().secrets.map((row) => [
        row.key,
        row.value,
      ]),
    );
    expect(values.FOO).toBe("updated");
    expect(values.QUOTED).toBe("a b");
    expect(values.NEWLINE).toBe("line1\nline2");

    const json = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: auth,
      payload: { env: "dev", format: "json", contents: '{"JSON_KEY":"v"}' },
    });
    expect(json.statusCode).toBe(201);

    const malformed = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: auth,
      payload: { env: "dev", contents: "NOT A LINE" },
    });
    expect(malformed.statusCode).toBe(400);

    await app.inject({
      method: "PATCH",
      url: `/api/projects/${session.projectId}/environments/${session.prodId}/policy`,
      headers: auth,
      payload: { approvalRequired: true, requiredApprovals: 1 },
    });
    const blocked = await app.inject({
      method: "POST",
      url: `${url}/import`,
      headers: auth,
      payload: { env: "prod", contents: "PROD_KEY=1" },
    });
    expect(blocked.statusCode).toBe(409);

    const audit = await app.inject({
      method: "GET",
      url: `/api/audit?projectId=${session.projectId}`,
      headers: auth,
    });
    const logs = audit.json<{ logs: { action: string }[] }>().logs;
    expect(logs.some((log) => log.action === "secret.import")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("postgres://");
  });

  it("writes audit entries without secret values", async () => {
    const session = await signup(`audit-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };

    await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/secrets`,
      headers: auth,
      payload: { key: "TOKEN", value: "super-secret-value", env: "dev" },
    });

    const audit = await app.inject({
      method: "GET",
      url: `/api/audit?projectId=${session.projectId}`,
      headers: auth,
    });
    expect(audit.statusCode).toBe(200);
    const logs = audit.json<{ logs: { action: string; metadata: Record<string, unknown> }[] }>().logs;
    expect(logs.some((log) => log.action === "secret.write")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("super-secret-value");
  });

  it("invites teammates into the same organization", async () => {
    const owner = await signup(`invite-owner-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const mateEmail = `invite-mate-${Date.now()}@test.dev`;

    const created = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: auth,
      payload: { email: mateEmail, role: "member" },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json<{ token: string }>().token;

    const info = await app.inject({
      method: "GET",
      url: `/api/auth/invite?token=${encodeURIComponent(token)}`,
    });
    expect(info.statusCode).toBe(200);
    expect(info.json<{ invite: { email: string } }>().invite.email).toBe(mateEmail);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token, name: "Mate", password: "correct-horse-battery" },
    });
    expect(accepted.statusCode).toBe(201);
    const mate = accepted.json<{ token: string; user: { role: string } }>();
    expect(mate.user.role).toBe("member");

    const org = await app.inject({ method: "GET", url: "/api/org", headers: auth });
    expect(org.json<{ members: unknown[] }>().members).toHaveLength(2);

    const mateProjects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${mate.token}` },
    });
    expect(mateProjects.json<{ projects: unknown[] }>().projects).toHaveLength(1);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: auth,
      payload: { email: mateEmail, role: "viewer" },
    });
    expect(duplicate.statusCode).toBe(409);

    const mateInvite = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: { authorization: `Bearer ${mate.token}` },
      payload: { email: `nobody-${Date.now()}@test.dev`, role: "viewer" },
    });
    expect(mateInvite.statusCode).toBe(403);
  });

  it("protects owner-only rules and the last owner", async () => {
    const owner = await signup(`owner-rules-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const org = await app.inject({ method: "GET", url: "/api/org", headers: auth });
    const currentUserId = org.json<{ currentUserId: string }>().currentUserId;

    const demoteSelf = await app.inject({
      method: "PATCH",
      url: `/api/org/members/${currentUserId}`,
      headers: auth,
      payload: { role: "admin" },
    });
    expect(demoteSelf.statusCode).toBe(409);

    const adminEmail = `admin-${Date.now()}@test.dev`;
    const adminInvite = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: auth,
      payload: { email: adminEmail, role: "admin" },
    });
    const adminToken = adminInvite.json<{ token: string }>().token;
    const adminAccepted = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token: adminToken, name: "Admin", password: "correct-horse-battery" },
    });
    const adminAuth = {
      authorization: `Bearer ${adminAccepted.json<{ token: string }>().token}`,
    };

    const adminGrantsOwner = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: adminAuth,
      payload: { email: `owner2-${Date.now()}@test.dev`, role: "owner" },
    });
    expect(adminGrantsOwner.statusCode).toBe(403);

    const adminTouchesOwner = await app.inject({
      method: "PATCH",
      url: `/api/org/members/${currentUserId}`,
      headers: adminAuth,
      payload: { role: "viewer" },
    });
    expect(adminTouchesOwner.statusCode).toBe(403);

    const removeOwner = await app.inject({
      method: "DELETE",
      url: `/api/org/members/${currentUserId}`,
      headers: adminAuth,
    });
    expect(removeOwner.statusCode).toBe(403);
  });

  it("rejects expired, revoked, and wrong-password invites", async () => {
    const owner = await signup(`invite-edge-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const email = `edge-${Date.now()}@test.dev`;

    const created = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: auth,
      payload: { email, role: "viewer" },
    });
    const { token, invite } = created.json<{ token: string; invite: { id: string } }>();

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token, name: "Edge", password: "short" },
    });
    expect(wrongPassword.statusCode).toBe(400);

    await app.inject({
      method: "DELETE",
      url: `/api/org/invites/${invite.id}`,
      headers: auth,
    });
    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/auth/invite?token=${encodeURIComponent(token)}`,
    });
    expect(afterRevoke.statusCode).toBe(404);

    const bogus = await app.inject({
      method: "GET",
      url: "/api/auth/invite?token=not-a-real-token-value-at-all",
    });
    expect(bogus.statusCode).toBe(404);
  });

  it("routes sensitive environment writes through approvals", async () => {
    const owner = await signup(`approvals-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const projectId = owner.projectId;
    const secretsUrl = `/api/projects/${projectId}/secrets`;

    const policy = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${owner.prodId}/policy`,
      headers: auth,
      payload: { approvalRequired: true, requiredApprovals: 1 },
    });
    expect(policy.statusCode).toBe(200);

    const submitted = await app.inject({
      method: "POST",
      url: secretsUrl,
      headers: auth,
      payload: { key: "PROD_DB", value: "prod-secret", env: "prod" },
    });
    expect(submitted.statusCode).toBe(202);
    const requestId = submitted.json<{ changeRequest: { id: string } }>().changeRequest.id;

    const hidden = await app.inject({
      method: "GET",
      url: `${secretsUrl}?env=prod`,
      headers: auth,
    });
    expect(hidden.json<{ secrets: unknown[] }>().secrets).toHaveLength(0);

    const selfApprove = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/change-requests/${requestId}/approve`,
      headers: auth,
    });
    expect(selfApprove.statusCode).toBe(403);

    const admin = await inviteAndAccept(
      owner.token,
      `approver-${Date.now()}@test.dev`,
      "admin",
    );
    const adminAuth = { authorization: `Bearer ${admin.token}` };

    const pendingList = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/change-requests?status=pending`,
      headers: adminAuth,
    });
    expect(pendingList.json<{ changeRequests: { id: string }[] }>().changeRequests).toHaveLength(1);

    const approved = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/change-requests/${requestId}/approve`,
      headers: adminAuth,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ applied: boolean }>().applied).toBe(true);

    const visible = await app.inject({
      method: "GET",
      url: `${secretsUrl}?env=prod`,
      headers: adminAuth,
    });
    const rows = visible.json<{ secrets: { key: string; value: string }[] }>().secrets;
    expect(rows.find((row) => row.key === "PROD_DB")?.value).toBe("prod-secret");

    const rejectedRequest = await app.inject({
      method: "POST",
      url: secretsUrl,
      headers: auth,
      payload: { key: "PROD_DB2", value: "nope", env: "prod" },
    });
    const rejectId = rejectedRequest.json<{ changeRequest: { id: string } }>().changeRequest.id;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/change-requests/${rejectId}/reject`,
      headers: adminAuth,
      payload: { note: "not now" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json<{ applied: boolean }>().applied).toBe(false);

    const afterReject = await app.inject({
      method: "GET",
      url: `${secretsUrl}?env=prod`,
      headers: adminAuth,
    });
    expect(
      afterReject
        .json<{ secrets: { key: string }[] }>()
        .secrets.find((row) => row.key === "PROD_DB2"),
    ).toBeUndefined();
  });

  it("requires the configured number of distinct approvals", async () => {
    const owner = await signup(`threshold-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const projectId = owner.projectId;

    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${owner.prodId}/policy`,
      headers: auth,
      payload: { approvalRequired: true, requiredApprovals: 2 },
    });

    const submitted = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/secrets`,
      headers: auth,
      payload: { key: "TWO_MAN", value: "value", env: "prod" },
    });
    const requestId = submitted.json<{ changeRequest: { id: string } }>().changeRequest.id;

    const first = await inviteAndAccept(owner.token, `first-${Date.now()}@test.dev`, "admin");
    const second = await inviteAndAccept(owner.token, `second-${Date.now()}@test.dev`, "admin");
    const viewer = await inviteAndAccept(owner.token, `viewer-${Date.now()}@test.dev`, "viewer");

    const viewerAttempt = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/change-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    expect(viewerAttempt.statusCode).toBe(403);

    const firstApprove = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/change-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(firstApprove.statusCode).toBe(200);
    expect(firstApprove.json<{ applied: boolean }>().applied).toBe(false);

    const stillHidden = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/secrets?env=prod`,
      headers: auth,
    });
    expect(stillHidden.json<{ secrets: unknown[] }>().secrets).toHaveLength(0);

    const secondApprove = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/change-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(secondApprove.statusCode).toBe(200);
    expect(secondApprove.json<{ applied: boolean }>().applied).toBe(true);

    const applied = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/secrets?env=prod`,
      headers: auth,
    });
    expect(
      applied.json<{ secrets: { key: string; value: string }[] }>().secrets[0],
    ).toMatchObject({ key: "TWO_MAN", value: "value" });
  });

  it("signs in with OIDC and provisions an organization", async () => {
    const email = `oidc-${Date.now()}@test.dev`;
    const first = await ssoLogin(email, "OIDC User");
    expect(first.user.email).toBe(email);
    expect(first.user.role).toBe("owner");

    const projects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(projects.json<{ projects: unknown[] }>().projects).toHaveLength(1);

    const second = await ssoLogin(email, "OIDC User");
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.orgId).toBe(first.user.orgId);

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${first.token}` },
    });
    const logs = audit.json<{ logs: { action: string }[] }>().logs;
    expect(logs.some((log) => log.action === "auth.oidc.login")).toBe(true);
  });

  it("joins an organization through a pending invite with OIDC", async () => {
    const owner = await signup(`oidc-invite-owner-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const org = await app.inject({ method: "GET", url: "/api/org", headers: auth });
    const orgId = org.json<{ org: { id: string } }>().org.id;

    const email = `oidc-invited-${Date.now()}@test.dev`;
    const invite = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: auth,
      payload: { email, role: "member" },
    });
    expect(invite.statusCode).toBe(201);

    const login = await ssoLogin(email, "Invited User");
    expect(login.user.orgId).toBe(orgId);
    expect(login.user.role).toBe("member");

    const projects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(projects.json<{ projects: unknown[] }>().projects).toHaveLength(1);
  });

  it("enforces SSO domain and auto-create policies", async () => {
    env.oidc!.allowedDomains = ["allowed.dev"];
    const blockedEmail = `blocked-${Date.now()}@test.dev`;
    const blockedStart = await startSso(blockedEmail, "Blocked");
    const blocked = await finishSso(blockedStart.callbackPath, blockedStart.cookie);
    expect(blocked.statusCode).toBe(302);
    expect(String(blocked.headers.location)).toContain("sso_error");
    expect(cookieValue(blocked.headers["set-cookie"], "opensiel_session")).toBeNull();
    env.oidc!.allowedDomains = [];

    env.oidc!.autoCreate = false;
    const unknownEmail = `unknown-${Date.now()}@test.dev`;
    const unknownStart = await startSso(unknownEmail, "Unknown");
    const unknown = await finishSso(unknownStart.callbackPath, unknownStart.cookie);
    expect(unknown.statusCode).toBe(302);
    expect(String(unknown.headers.location)).toContain("sso_error");

    const rows = await database.sql<{ count: number }[]>`
      select count(*)::int as count from users where email = ${unknownEmail}
    `;
    expect(rows[0]?.count).toBe(0);
    env.oidc!.autoCreate = true;
  });

  it("serves SAML service-provider metadata", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/saml/metadata" });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["content-type"])).toContain("xml");
    expect(response.body).toContain("entityID");
    expect(response.body).toContain("/api/auth/saml/callback");
  });

  it("signs in with a signed SAML assertion", async () => {
    const email = `saml-${Date.now()}@test.dev`;
    const first = await samlLogin(email, "Sam L");
    expect(first.user.email).toBe(email);
    expect(first.user.role).toBe("owner");

    const projects = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(projects.json<{ projects: unknown[] }>().projects).toHaveLength(1);

    const second = await samlLogin(email, "Sam L");
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.orgId).toBe(first.user.orgId);

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(
      audit
        .json<{ logs: { action: string }[] }>()
        .logs.some((log) => log.action === "auth.saml.login"),
    ).toBe(true);
  });

  it("joins an organization through a SAML invite", async () => {
    const owner = await signup(`saml-owner-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const org = await app.inject({ method: "GET", url: "/api/org", headers: auth });
    const orgId = org.json<{ org: { id: string } }>().org.id;

    const email = `saml-invited-${Date.now()}@test.dev`;
    const invite = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: auth,
      payload: { email, role: "member" },
    });
    expect(invite.statusCode).toBe(201);

    const login = await samlLogin(email, "Invited Sam");
    expect(login.user.orgId).toBe(orgId);
    expect(login.user.role).toBe("member");
  });

  it("rejects SAML domain restrictions and invalid assertions", async () => {
    env.saml!.allowedDomains = ["allowed.dev"];

    const blockedEmail = `blocked-${Date.now()}@test.dev`;
    const blockedXml = buildSamlResponse(blockedEmail, "Blocked");
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        SAMLResponse: Buffer.from(blockedXml).toString("base64"),
      }).toString(),
    });
    expect(blocked.statusCode).toBe(302);
    expect(String(blocked.headers.location)).toContain("sso_error");
    expect(cookieValue(blocked.headers["set-cookie"], "opensiel_session")).toBeNull();
    env.saml!.allowedDomains = [];

    const invalid = await app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "SAMLResponse=not-valid",
    });
    expect(invalid.statusCode).toBe(302);
    expect(String(invalid.headers.location)).toContain("sso_error");
  });

  it("scans text for stored secrets and credential patterns", async () => {
    const session = await signup(`scan-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const projectId = session.projectId;
    const secretValue = "super-secret-scan-value";

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/secrets`,
      headers: auth,
      payload: { key: "SCAN_TOKEN", value: secretValue, env: "dev" },
    });
    expect(created.statusCode).toBe(201);

    const contents = ["line one", `leaked ${secretValue} here`, "AKIAABCDEFGHIJKLMNOP"].join("\n");
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/scan`,
      headers: auth,
      payload: { contents },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      findings: {
        type: string;
        name: string;
        environment?: string;
        line: number;
        preview: string;
      }[];
      scannedEnvironments: number;
      scannedSecrets: number;
    }>();

    expect(body.scannedEnvironments).toBe(3);
    expect(body.scannedSecrets).toBe(1);

    const stored = body.findings.find(
      (finding) => finding.type === "stored-secret" && finding.name === "SCAN_TOKEN",
    );
    expect(stored).toMatchObject({ environment: "dev", line: 2 });
    expect(stored?.preview).not.toContain(secretValue);

    const aws = body.findings.find(
      (finding) => finding.type === "pattern" && finding.name === "AWS access key",
    );
    expect(aws).toBeTruthy();
    expect(JSON.stringify(body.findings)).not.toContain(secretValue);

    const empty = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/scan`,
      headers: auth,
      payload: { contents: "" },
    });
    expect(empty.statusCode).toBe(400);

    const identity = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/identities`,
      headers: auth,
      payload: { name: "scanner", role: "viewer", environmentIds: [session.devId] },
    });
    const credentials = identity.json<{
      identity: { clientId: string; clientSecret: string };
    }>().identity;
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    });
    const machineToken = tokenResponse.json<{ accessToken: string }>().accessToken;

    const machineScan = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/scan`,
      headers: { authorization: `Bearer ${machineToken}` },
      payload: { contents: "whatever" },
    });
    expect(machineScan.statusCode).toBe(403);

    const audit = await app.inject({
      method: "GET",
      url: `/api/audit?projectId=${projectId}`,
      headers: auth,
    });
    expect(
      audit
        .json<{ logs: { action: string }[] }>()
        .logs.some((log) => log.action === "secret.scan"),
    ).toBe(true);
  });

  it("issues and revokes dynamic postgres credentials", async () => {
    const session = await signup(`dynamic-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const projectId = session.projectId;
    const base = `/api/projects/${projectId}/dynamic-secrets`;

    const configResponse = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { name: "pg", adminUrl: databaseUrl, ttlSeconds: 300 },
    });
    expect(configResponse.statusCode).toBe(201);
    const config = configResponse.json<{
      configuration: { id: string; name: string; ttlSeconds: number };
    }>().configuration;
    expect(config.ttlSeconds).toBe(300);
    expect(JSON.stringify(configResponse.json())).not.toContain("postgres://");

    const viewer = await inviteAndAccept(
      session.token,
      `dynamic-viewer-${Date.now()}@test.dev`,
      "viewer",
    );
    const forbidden = await app.inject({
      method: "POST",
      url: base,
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { name: "nope", adminUrl: databaseUrl },
    });
    expect(forbidden.statusCode).toBe(403);

    const leaseResponse = await app.inject({
      method: "POST",
      url: `${base}/${config.id}/leases`,
      headers: auth,
    });
    expect(leaseResponse.statusCode).toBe(201);
    const leaseBody = leaseResponse.json<{
      lease: { id: string; username: string; status: string };
      username: string;
      password: string;
      host: string;
      database: string;
    }>();
    expect(leaseBody.lease.status).toBe("active");
    expect(leaseBody.username).toMatch(/^opensiel_[a-z0-9]+$/);
    expect(leaseBody.host).toBeTruthy();

    const target = new URL(databaseUrl!);
    target.username = leaseBody.username;
    target.password = leaseBody.password;

    const client = postgres(target.toString(), {
      max: 1,
      connect_timeout: 5,
      onnotice: () => {},
    });
    try {
      const rows = await client<{ current_user: string }[]>`select current_user`;
      expect(rows[0]?.current_user).toBe(leaseBody.username);
    } finally {
      await client.end({ timeout: 5 });
    }

    const leases = await app.inject({ method: "GET", url: `${base}/leases`, headers: auth });
    expect(
      leases
        .json<{ leases: { id: string; username: string }[] }>()
        .leases.some((lease) => lease.id === leaseBody.lease.id),
    ).toBe(true);

    const revoked = await app.inject({
      method: "POST",
      url: `${base}/leases/${leaseBody.lease.id}/revoke`,
      headers: auth,
    });
    expect(revoked.statusCode).toBe(200);

    let connectionFailed = false;
    const closed = postgres(target.toString(), {
      max: 1,
      connect_timeout: 5,
      onnotice: () => {},
    });
    try {
      await closed`select 1`;
    } catch {
      connectionFailed = true;
    } finally {
      await closed.end({ timeout: 5 });
    }
    expect(connectionFailed).toBe(true);

    const audit = await app.inject({
      method: "GET",
      url: `/api/audit?projectId=${projectId}`,
      headers: auth,
    });
    const actions = audit.json<{ logs: { action: string }[] }>().logs.map((log) => log.action);
    expect(actions).toContain("dynamic.lease.create");
    expect(actions).toContain("dynamic.lease.revoke");
  });

  it("delivers signed webhook events without secret values", async () => {
    const session = await signup(`hooks-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const projectId = session.projectId;
    const base = `/api/projects/${projectId}/webhooks`;

    const created = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { url: hookUrl, events: ["secret.created"] },
    });
    expect(created.statusCode).toBe(201);
    const { webhook, signingSecret } = created.json<{
      webhook: { id: string };
      signingSecret: string;
    }>();
    expect(signingSecret.length).toBeGreaterThanOrEqual(16);

    const viewer = await inviteAndAccept(
      session.token,
      `hooks-viewer-${Date.now()}@test.dev`,
      "viewer",
    );
    const forbidden = await app.inject({
      method: "POST",
      url: base,
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { url: hookUrl, events: ["secret.created"] },
    });
    expect(forbidden.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/secrets`,
      headers: auth,
      payload: { key: "HOOK_KEY", value: "hook-secret-value", env: "dev" },
    });

    const delivery = await nextHook();
    expect(delivery.headers["x-opensiel-event"]).toBe("secret.created");
    expect(delivery.body).not.toContain("hook-secret-value");
    const payload = JSON.parse(delivery.body) as {
      event: string;
      resource: { key: string; environment: string };
    };
    expect(payload.event).toBe("secret.created");
    expect(payload.resource.key).toBe("HOOK_KEY");
    expect(payload.resource.environment).toBe("dev");

    const expected = createHmac("sha256", signingSecret).update(delivery.body).digest("hex");
    expect(delivery.headers["x-opensiel-signature"]).toBe(`sha256=${expected}`);

    await vi.waitFor(async () => {
      const list = await app.inject({ method: "GET", url: base, headers: auth });
      expect(
        list.json<{ webhooks: { lastStatus: number | null }[] }>().webhooks[0]?.lastStatus,
      ).toBe(200);
    });

    await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { url: hookUrl, events: ["secret.updated"] },
    });

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/secrets`,
      headers: auth,
      payload: { key: "HOOK_KEY", value: "hook-secret-value-2", env: "dev" },
    });

    const updateDelivery = await nextHook();
    expect(updateDelivery.headers["x-opensiel-event"]).toBe("secret.updated");

    const testDelivery = await app.inject({
      method: "POST",
      url: `${base}/${webhook.id}/test`,
      headers: auth,
    });
    expect(testDelivery.statusCode).toBe(200);
    expect(testDelivery.json<{ delivered: boolean }>().delivered).toBe(true);
    const testHook = await nextHook();
    expect(testHook.headers["x-opensiel-event"]).toBe("webhook.test");

    const audit = await app.inject({
      method: "GET",
      url: `/api/audit?projectId=${projectId}`,
      headers: auth,
    });
    const actions = audit.json<{ logs: { action: string }[] }>().logs.map((log) => log.action);
    expect(actions).toContain("webhook.create");
    expect(actions).toContain("webhook.test");
  });

  it("rotates project data keys to the next master key", async () => {
    const owner = await signup(`rotate-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const projectId = owner.projectId;

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/secrets`,
      headers: auth,
      payload: { key: "ROTATE_ME", value: "rotate-value", env: "dev" },
    });

    const status = await app.inject({ method: "GET", url: "/api/admin/key", headers: auth });
    expect(status.statusCode).toBe(200);
    expect(status.json<{ currentVersion: number; nextConfigured: boolean }>()).toMatchObject({
      currentVersion: 1,
      nextConfigured: false,
    });

    const noNext = await app.inject({
      method: "POST",
      url: "/api/admin/rotate-key",
      headers: auth,
    });
    expect(noNext.statusCode).toBe(409);

    const member = await inviteAndAccept(
      owner.token,
      `rotate-member-${Date.now()}@test.dev`,
      "member",
    );
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/rotate-key",
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(forbidden.statusCode).toBe(403);

    env.nextMasterKey = parseMasterKey(generateMasterKey());
    env.nextMasterKeyVersion = 2;

    const rotated = await app.inject({
      method: "POST",
      url: "/api/admin/rotate-key",
      headers: auth,
    });
    expect(rotated.statusCode).toBe(200);
    const result = rotated.json<{ rotated: number; targetVersion: number }>();
    expect(result.targetVersion).toBe(2);
    expect(result.rotated).toBeGreaterThanOrEqual(1);

    const readable = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/secrets?env=dev`,
      headers: auth,
    });
    expect(
      readable.json<{ secrets: { key: string; value: string }[] }>().secrets.find(
        (secret) => secret.key === "ROTATE_ME",
      )?.value,
    ).toBe("rotate-value");

    const versions = await database.sql<{ kek_version: number }[]>`
      select distinct kek_version from projects order by kek_version
    `;
    expect(versions.map((row) => row.kek_version)).toEqual([2]);

    const nextKey = env.nextMasterKey!;
    env.masterKey = nextKey;
    env.masterKeyVersion = 2;
    env.nextMasterKey = undefined;
    env.nextMasterKeyVersion = undefined;

    const afterRestart = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/secrets?env=dev`,
      headers: auth,
    });
    expect(
      afterRestart.json<{ secrets: { key: string; value: string }[] }>().secrets.find(
        (secret) => secret.key === "ROTATE_ME",
      )?.value,
    ).toBe("rotate-value");

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "post-rotation" },
    });
    expect(created.statusCode).toBe(201);
    const newProjectId = created.json<{ project: { id: string } }>().project.id;
    const newRows = await database.sql<{ kek_version: number }[]>`
      select kek_version from projects where id = ${newProjectId}
    `;
    expect(newRows[0]?.kek_version).toBe(2);

    const audit = await app.inject({ method: "GET", url: "/api/audit", headers: auth });
    expect(
      audit
        .json<{ logs: { action: string }[] }>()
        .logs.some((log) => log.action === "admin.key_rotate"),
    ).toBe(true);
  });
}
