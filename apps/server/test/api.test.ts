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
import { runAuditSinkOnce } from "../src/audit-sink.js";
import { revokeExpiredRotationCredentials } from "../src/rotation.js";
import { base32Decode, currentTotpStep, totpCode } from "../src/mfa.js";
import { generateMasterKey, parseMasterKey, sha256 } from "../src/crypto.js";
import type { Env } from "../src/env.js";
import {
  decryptSecret,
  encryptSecret,
  generateIdentity,
  generateProjectKey,
  secretAad,
  unlockIdentity,
  unwrapProjectKey,
  wrapProjectKey,
} from "@opensiel/shared";

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
    awsStsEndpoint: "https://sts.amazonaws.com",
  };

  let app: FastifyInstance;
  let database: Database;
  let idp: FastifyInstance;
  let idpIssuer = "";
  let idpEmail = "";
  let idpName = "";
  let idpPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let idpJwk: Record<string, unknown>;
  let stsArn = "arn:aws:iam::123456789012:role/ci-deploy";
  const idpCodes = new Map<string, { nonce: string; email: string; name: string }>();

  let hookReceiver: FastifyInstance;
  let hookUrl = "";
  interface ReceivedHook {
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }
  const hookQueue: ReceivedHook[] = [];
  const hookWaiters: ((hook: ReceivedHook) => void)[] = [];
  const auditQueue: string[] = [];
  let auditFail = false;
  const rotationCalls: { created: Record<string, unknown>[]; revoked: Record<string, unknown>[] } =
    { created: [], revoked: [] };
  let rotationCreateCount = 0;
  const syncBodies: Record<string, unknown>[] = [];
  let syncFail = false;
  const kubeSecrets = new Map<string, Record<string, string>>();

  function nextHook(timeoutMs = 3000): Promise<ReceivedHook> {
    const queued = hookQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a webhook")),
        timeoutMs,
      );
      hookWaiters.push((hook) => {
        clearTimeout(timer);
        resolve(hook);
      });
    });
  }

  function cookieValue(header: string | string[] | undefined, name: string): string | null {
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

  function totpNow(secret: string): string {
    return totpCode(base32Decode(secret), currentTotpStep());
  }

  async function signup(email: string, name = "Test User"): Promise<Session> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct-horse-battery", name },
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
    idp.post("/sts", async (request, reply) => {
      if (!request.headers.authorization) {
        return reply.code(403).send({ error: "missing authorization" });
      }
      return reply
        .type("text/xml")
        .send(
          `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${stsArn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`,
        );
    });
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
    env.awsStsEndpoint = `${idpIssuer}/sts`;

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
    hookReceiver.post("/audit", async (request, reply) => {
      if (auditFail) return reply.code(500).send({ ok: false });
      auditQueue.push(request.body as string);
      return reply.code(200).send({ ok: true });
    });
    hookReceiver.post("/rotate/create", async (request, reply) => {
      rotationCreateCount += 1;
      rotationCalls.created.push(JSON.parse(request.body as string) as Record<string, unknown>);
      return reply.send({
        value: `rotated-value-${rotationCreateCount}`,
        credentialId: `cred-${rotationCreateCount}`,
      });
    });
    hookReceiver.post("/rotate/revoke", async (request, reply) => {
      rotationCalls.revoked.push(JSON.parse(request.body as string) as Record<string, unknown>);
      return reply.send({ ok: true });
    });
    hookReceiver.post("/sync-target", async (request, reply) => {
      if (syncFail) return reply.code(500).send({ ok: false });
      syncBodies.push(JSON.parse(request.body as string) as Record<string, unknown>);
      return reply.send({ ok: true });
    });
    hookReceiver.get("/api/v1/namespaces/:namespace/secrets/:name", async (request, reply) => {
      const { name } = request.params as { name: string };
      const data = kubeSecrets.get(name);
      if (!data) return reply.code(404).send({ error: "not found" });
      return reply.send({ metadata: { name, resourceVersion: "1" }, data });
    });
    hookReceiver.post("/api/v1/namespaces/:namespace/secrets", async (request, reply) => {
      const body = JSON.parse(request.body as string) as {
        metadata: { name: string };
        data: Record<string, string>;
      };
      kubeSecrets.set(body.metadata.name, body.data);
      return reply.code(201).send({ ok: true });
    });
    hookReceiver.put("/api/v1/namespaces/:namespace/secrets/:name", async (request, reply) => {
      const { name } = request.params as { name: string };
      const body = JSON.parse(request.body as string) as {
        data: Record<string, string>;
      };
      kubeSecrets.set(name, body.data);
      return reply.send({ ok: true });
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

    const latest = await app.inject({
      method: "GET",
      url: `${base}/DATABASE_URL?env=dev`,
      headers: auth,
    });
    expect(latest.json<{ secret: { value: string } }>().secret.value).toBe("v2");

    const versions = await app.inject({
      method: "GET",
      url: `${base}/DATABASE_URL/versions?env=dev`,
      headers: auth,
    });
    const versionRows = versions.json<{
      versions: { version: number; fingerprint: string; fingerprintVersion: number }[];
    }>().versions;
    expect(versionRows).toHaveLength(2);
    expect(versionRows.every((row) => row.fingerprintVersion === 2)).toBe(true);
    expect(versionRows.map((row) => row.fingerprint)).not.toContain(sha256("v1"));
    expect(versionRows.map((row) => row.fingerprint)).not.toContain(sha256("v2"));

    const rollback = await app.inject({
      method: "POST",
      url: `${base}/DATABASE_URL/rollback`,
      headers: auth,
      payload: { version: 1, env: "dev" },
    });
    expect(rollback.statusCode).toBe(201);
    expect(rollback.json<{ secret: { version: number } }>().secret.version).toBe(3);

    const after = await app.inject({
      method: "GET",
      url: `${base}/DATABASE_URL?env=dev`,
      headers: auth,
    });
    expect(after.json<{ secret: { value: string } }>().secret.value).toBe("v1");

    const exported = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/export?env=dev&format=dotenv`,
      headers: auth,
    });
    expect(exported.body).toContain("DATABASE_URL=v1");
  });

  it("diffs versions and restores an environment to a point in time", async () => {
    const session = await signup(`pitr-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}/secrets`;

    await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { key: "GREETING", value: "one", env: "dev" },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { key: "GREETING", value: "two", env: "dev" },
    });

    const history = await app.inject({
      method: "GET",
      url: `${base}/GREETING/versions?env=dev`,
      headers: auth,
    });
    const versions = history.json<{
      versions: { version: number; createdAt: string }[];
    }>().versions;
    expect(versions).toHaveLength(2);
    const v1 = versions.find((row) => row.version === 1)!;
    const v2 = versions.find((row) => row.version === 2)!;
    const cutoff = new Date(
      (new Date(v1.createdAt).getTime() + new Date(v2.createdAt).getTime()) / 2,
    ).toISOString();

    const masked = await app.inject({
      method: "GET",
      url: `${base}/GREETING/diff?env=dev&from=1&to=2`,
      headers: auth,
    });
    expect(masked.statusCode).toBe(200);
    expect(masked.json<{ diff: { changed: boolean; revealed: boolean } }>().diff).toMatchObject({
      changed: true,
      revealed: false,
    });

    const revealed = await app.inject({
      method: "GET",
      url: `${base}/GREETING/diff?env=dev&from=1&to=2&reveal=true`,
      headers: auth,
    });
    expect(
      revealed.json<{ diff: { from: { value: string }; to: { value: string } } }>().diff,
    ).toMatchObject({ from: { value: "one" }, to: { value: "two" } });

    const preview = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/point-in-time?env=dev&at=${encodeURIComponent(cutoff)}`,
      headers: auth,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ changes: unknown[] }>().changes).toHaveLength(1);

    const dryRun = await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/point-in-time/restore`,
      headers: auth,
      payload: { env: "dev", at: cutoff, dryRun: true },
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json<{ restored: number; dryRun: boolean }>()).toMatchObject({
      restored: 0,
      dryRun: true,
    });

    const restore = await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/point-in-time/restore`,
      headers: auth,
      payload: { env: "dev", at: cutoff },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json<{ restored: number }>().restored).toBe(1);

    const current = await app.inject({
      method: "GET",
      url: `${base}/GREETING?env=dev`,
      headers: auth,
    });
    expect(current.json<{ secret: { value: string; version: number } }>().secret).toMatchObject({
      value: "one",
      version: 3,
    });
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
    const identity = created.json<{
      identity: { id: string; clientId: string; clientSecret: string };
    }>().identity;

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
      list
        .json<{ secrets: { key: string; value: string }[] }>()
        .secrets.map((row) => [row.key, row.value]),
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
    expect(importsList.json<{ imports: { targetEnvironmentId: string }[] }>().imports).toHaveLength(
      1,
    );

    const identity = await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/identities`,
      headers: auth,
      payload: { name: "staging-reader", role: "viewer", environmentIds: [session.stagingId] },
    });
    const created = identity.json<{ identity: { clientId: string; clientSecret: string } }>()
      .identity;
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

    const contents = ["# seeded", "FOO=bar", 'export QUOTED="a b"', 'NEWLINE="line1\\nline2"'].join(
      "\n",
    );

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
      list
        .json<{ secrets: { key: string; value: string }[] }>()
        .secrets.map((row) => [row.key, row.value]),
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
    const logs = audit.json<{ logs: { action: string; metadata: Record<string, unknown> }[] }>()
      .logs;
    expect(logs.some((log) => log.action === "secret.write")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("super-secret-value");
  });

  it("exports audit logs as csv and jsonl without secret values", async () => {
    const session = await signup(`audit-export-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };

    await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/secrets`,
      headers: auth,
      payload: { key: "EXPORTED", value: "export-payload-xyz", env: "dev" },
    });

    const csv = await app.inject({
      method: "GET",
      url: "/api/audit/export?format=csv",
      headers: auth,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    const [header, ...rows] = csv.body.trim().split("\n");
    expect(header).toBe(
      "id,createdAt,actorType,actorId,actorName,action,resourceType,resourceId,projectId,ip,metadata",
    );
    expect(rows.some((row) => row.includes("secret.write"))).toBe(true);
    expect(csv.body).not.toContain("export-payload-xyz");

    const formula = await signup(`audit-formula-${Date.now()}@test.dev`, "=1+1");
    await app.inject({
      method: "POST",
      url: `/api/projects/${formula.projectId}/secrets`,
      headers: { authorization: `Bearer ${formula.token}` },
      payload: { key: "SAFE", value: "x", env: "dev" },
    });
    const formulaCsv = await app.inject({
      method: "GET",
      url: "/api/audit/export?format=csv",
      headers: { authorization: `Bearer ${formula.token}` },
    });
    expect(formulaCsv.body).toContain("'=1+1");
    expect(formulaCsv.body).not.toMatch(/,=1\+1,/);

    const jsonl = await app.inject({
      method: "GET",
      url: "/api/audit/export?format=jsonl",
      headers: auth,
    });
    expect(jsonl.statusCode).toBe(200);
    const entries = jsonl.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; metadata: unknown });
    expect(entries.some((entry) => entry.action === "secret.write")).toBe(true);
    expect(entries.some((entry) => entry.action === "audit.export")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("export-payload-xyz");

    const filtered = await app.inject({
      method: "GET",
      url: "/api/audit/export?format=jsonl&action=secret.write",
      headers: auth,
    });
    const filteredEntries = filtered.body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string });
    expect(filteredEntries.length).toBeGreaterThan(0);
    expect(filteredEntries.every((entry) => entry.action === "secret.write")).toBe(true);

    const other = await signup(`audit-other-${Date.now()}@test.dev`);
    const otherCsv = await app.inject({
      method: "GET",
      url: "/api/audit/export?format=csv",
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(otherCsv.body).not.toContain("EXPORTED");
  });

  it("delivers audit events to the configured sink with a checkpoint", async () => {
    const session = await signup(`audit-sink-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const sinkEnv: Env = {
      ...env,
      auditSink: {
        type: "http",
        url: hookUrl.replace(/\/hook$/, "/audit"),
        intervalSeconds: 60,
        batchSize: 500,
      },
    };
    const sinkDeps = { env: sinkEnv, db: database.db, sql: database.sql };
    await database.sql`
      update audit_sink_state
      set next_attempt_at = null, failure_count = 0, last_error = null
      where id = 'default'
    `;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const drained = await runAuditSinkOnce(sinkDeps);
      if (drained.sent === 0) break;
    }
    auditQueue.length = 0;

    await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/secrets`,
      headers: auth,
      payload: { key: "SINK_KEY", value: "sink-secret-value", env: "dev" },
    });

    const delivered = await runAuditSinkOnce(sinkDeps);
    expect(delivered.sent).toBe(1);
    expect(auditQueue).toHaveLength(1);
    const payload = JSON.parse(auditQueue[0]) as {
      events: { action: string; metadata: unknown }[];
    };
    expect(payload.events.map((event) => event.action)).toEqual(["secret.write"]);
    expect(payload.events).toHaveLength(1);
    expect(auditQueue[0]).not.toContain("sink-secret-value");

    const idle = await runAuditSinkOnce(sinkDeps);
    expect(idle.sent).toBe(0);
  });

  it("backs off after a sink delivery failure", async () => {
    const session = await signup(`audit-sink-fail-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const sinkEnv: Env = {
      ...env,
      auditSink: {
        type: "http",
        url: hookUrl.replace(/\/hook$/, "/audit"),
        intervalSeconds: 60,
        batchSize: 500,
      },
    };
    const sinkDeps = { env: sinkEnv, db: database.db, sql: database.sql };

    await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/secrets`,
      headers: auth,
      payload: { key: "SINK_RETRY", value: "retry-value", env: "dev" },
    });

    auditFail = true;
    try {
      const failed = await runAuditSinkOnce(sinkDeps);
      expect(failed.sent).toBe(0);
      expect(failed.error).toContain("500");

      const skipped = await runAuditSinkOnce(sinkDeps);
      expect(skipped.sent).toBe(0);
      expect(skipped.skipped).toBe("backoff");
    } finally {
      auditFail = false;
      await database.sql`
        update audit_sink_state
        set next_attempt_at = null, failure_count = 0, last_error = null
        where id = 'default'
      `;
    }
  });

  it("encrypts and decrypts payloads with project transit keys", async () => {
    const session = await signup(`transit-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}/crypto`;

    const encrypted = await app.inject({
      method: "POST",
      url: `${base}/encrypt`,
      headers: auth,
      payload: { plaintext: "card=4111", context: "user:1" },
    });
    expect(encrypted.statusCode).toBe(200);
    const envelope = encrypted.json<{
      ciphertext: string;
      key: string;
      keyVersion: number;
      algorithm: string;
    }>();
    expect(envelope).toMatchObject({ key: "default", keyVersion: 1, algorithm: "AES-256-GCM" });
    expect(envelope.ciphertext.startsWith("osl1.default.1.")).toBe(true);

    const decrypted = await app.inject({
      method: "POST",
      url: `${base}/decrypt`,
      headers: auth,
      payload: { ciphertext: envelope.ciphertext, context: "user:1" },
    });
    expect(decrypted.statusCode).toBe(200);
    expect(decrypted.json<{ plaintext: string }>().plaintext).toBe("card=4111");

    for (const context of ["user:2", undefined]) {
      const denied = await app.inject({
        method: "POST",
        url: `${base}/decrypt`,
        headers: auth,
        payload: { ciphertext: envelope.ciphertext, context },
      });
      expect(denied.statusCode).toBe(400);
      expect(denied.json<{ error: string }>().error).toBe("decrypt_failed");
    }

    const malformed = await app.inject({
      method: "POST",
      url: `${base}/decrypt`,
      headers: auth,
      payload: { ciphertext: "not-an-envelope" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: string }>().error).toBe("invalid_ciphertext");

    const unknown = await app.inject({
      method: "POST",
      url: `${base}/decrypt`,
      headers: auth,
      payload: { ciphertext: "osl1.ghost.1.aXY=.dGFn.abc" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>().error).toBe("unknown_transit_key");

    const created = await app.inject({
      method: "POST",
      url: `${base}/keys`,
      headers: auth,
      payload: { name: "billing" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ key: { name: string; version: number } }>().key).toMatchObject({
      name: "billing",
      version: 1,
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `${base}/keys`,
      headers: auth,
      payload: { name: "billing" },
    });
    expect(duplicate.statusCode).toBe(409);

    const withNamedKey = await app.inject({
      method: "POST",
      url: `${base}/encrypt`,
      headers: auth,
      payload: { plaintext: "invoice", key: "billing" },
    });
    expect(withNamedKey.statusCode).toBe(200);
    const named = withNamedKey.json<{ ciphertext: string; keyVersion: number }>();
    expect(named.ciphertext.startsWith("osl1.billing.1.")).toBe(true);

    const rotated = await app.inject({
      method: "POST",
      url: `${base}/keys/billing/rotate`,
      headers: auth,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json<{ key: { version: number } }>().key.version).toBe(2);

    const afterRotation = await app.inject({
      method: "POST",
      url: `${base}/encrypt`,
      headers: auth,
      payload: { plaintext: "invoice", key: "billing" },
    });
    expect(afterRotation.json<{ keyVersion: number }>().keyVersion).toBe(2);

    const oldCiphertext = await app.inject({
      method: "POST",
      url: `${base}/decrypt`,
      headers: auth,
      payload: { ciphertext: named.ciphertext },
    });
    expect(oldCiphertext.statusCode).toBe(200);
    expect(oldCiphertext.json<{ plaintext: string }>().plaintext).toBe("invoice");

    const keys = await app.inject({ method: "GET", url: `${base}/keys`, headers: auth });
    expect(keys.json<{ keys: { name: string; version: number }[] }>().keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "billing", version: 2 }),
        expect.objectContaining({ name: "default", version: 1 }),
      ]),
    );
  });

  it("enforces identity token policy and revokes outstanding tokens", async () => {
    const session = await signup(`identity-policy-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}/identities`;

    const created = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: {
        name: "ci",
        role: "viewer",
        environmentIds: [session.devId],
        tokenTtlSeconds: 60,
        ipAllowlist: ["127.0.0.1/32"],
        hourlyTokenCap: 2,
      },
    });
    expect(created.statusCode).toBe(201);
    const identity = created.json<{
      identity: { id: string; clientId: string; clientSecret: string; tokenTtlSeconds: number };
    }>().identity;
    expect(identity.tokenTtlSeconds).toBe(60);

    const credentials = { clientId: identity.clientId, clientSecret: identity.clientSecret };
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: credentials,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ expiresIn: number }>().expiresIn).toBe(60);
    const firstToken = first.json<{ accessToken: string }>().accessToken;

    const second = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: credentials,
    });
    expect(second.statusCode).toBe(200);

    const third = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: credentials,
    });
    expect(third.statusCode).toBe(429);
    expect(third.json<{ error: string }>().error).toBe("token_limit_reached");

    const patched = await app.inject({
      method: "PATCH",
      url: `${base}/${identity.id}`,
      headers: auth,
      payload: { role: "member", ipAllowlist: ["10.0.0.0/8"], hourlyTokenCap: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(
      patched.json<{ identity: { role: string; ipAllowlist: string[] } }>().identity,
    ).toMatchObject({ role: "member", ipAllowlist: ["10.0.0.0/8"] });

    const stale = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/secrets?env=dev`,
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(stale.statusCode).toBe(401);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: credentials,
    });
    expect(blocked.statusCode).toBe(403);

    const restored = await app.inject({
      method: "PATCH",
      url: `${base}/${identity.id}`,
      headers: auth,
      payload: { ipAllowlist: ["127.0.0.1/32"], tokenTtlSeconds: 3600 },
    });
    expect(restored.statusCode).toBe(200);

    const renewed = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: credentials,
    });
    expect(renewed.statusCode).toBe(200);
    const renewedToken = renewed.json<{ accessToken: string; expiresIn: number }>();
    expect(renewedToken.expiresIn).toBe(3600);

    const write = await app.inject({
      method: "POST",
      url: `/api/projects/${session.projectId}/secrets`,
      headers: { authorization: `Bearer ${renewedToken.accessToken}` },
      payload: { key: "FROM_MACHINE", value: "ok", env: "dev" },
    });
    expect(write.statusCode).toBe(201);

    const revoked = await app.inject({
      method: "POST",
      url: `${base}/${identity.id}/revoke`,
      headers: auth,
    });
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/secrets?env=dev`,
      headers: { authorization: `Bearer ${renewedToken.accessToken}` },
    });
    expect(afterRevoke.statusCode).toBe(401);

    const newToken = await app.inject({
      method: "POST",
      url: "/api/auth/token",
      payload: credentials,
    });
    expect(newToken.statusCode).toBe(401);
  });

  it("enrolls TOTP, requires it at login, and consumes recovery codes", async () => {
    const email = `mfa-${Date.now()}@test.dev`;
    const password = "correct-horse-battery";
    const session = await signup(email);
    const auth = { authorization: `Bearer ${session.token}` };

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/setup",
      headers: auth,
    });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUrl: uri } = setup.json<{ secret: string; otpauthUrl: string }>();
    expect(uri.startsWith("otpauth://totp/")).toBe(true);

    const enabled = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      headers: auth,
      payload: { code: totpNow(secret) },
    });
    expect(enabled.statusCode).toBe(201);
    const recoveryCodes = enabled.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    const status = await app.inject({ method: "GET", url: "/api/auth/mfa", headers: auth });
    expect(status.json()).toMatchObject({
      enabled: true,
      recoveryCodesRemaining: 10,
      orgRequired: false,
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    expect(first.statusCode).toBe(200);
    const challenge = first.json<{ mfaRequired: boolean; challengeToken: string }>();
    expect(challenge.mfaRequired).toBe(true);
    expect(challenge).not.toHaveProperty("token");

    const usedCode = totpNow(secret);
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/login",
      payload: { challengeToken: challenge.challengeToken, code: usedCode },
    });
    expect(second.statusCode).toBe(200);
    const token = second.json<{ token: string }>().token;
    expect(token).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/login",
      payload: { challengeToken: challenge.challengeToken, code: usedCode },
    });
    expect(replay.statusCode).toBe(401);

    const recovery = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/login",
      payload: { challengeToken: challenge.challengeToken, code: recoveryCodes[0] },
    });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json<{ recoveryCodesRemaining: number }>().recoveryCodesRemaining).toBe(9);

    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/login",
      payload: { challengeToken: challenge.challengeToken, code: recoveryCodes[0] },
    });
    expect(reuse.statusCode).toBe(401);

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/disable",
      headers: auth,
      payload: { password: "not-the-password", code: totpNow(secret) },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const disabled = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/disable",
      headers: auth,
      payload: { password, code: totpNow(secret) },
    });
    expect(disabled.statusCode).toBe(200);

    const plain = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toHaveProperty("token");
  });

  it("enforces the organization MFA policy during enrollment", async () => {
    const email = `mfa-policy-${Date.now()}@test.dev`;
    const password = "correct-horse-battery";
    const session = await signup(email);
    const auth = { authorization: `Bearer ${session.token}` };

    const policy = await app.inject({
      method: "PATCH",
      url: "/api/org/mfa",
      headers: auth,
      payload: { required: true },
    });
    expect(policy.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: string }>().error).toBe("mfa_enrollment_required");
    const enrollmentToken = blocked.json<{ enrollmentToken: string }>().enrollmentToken;

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/setup",
      payload: { enrollmentToken },
    });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json<{ secret: string }>();

    const verify = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/verify",
      payload: { enrollmentToken, code: totpNow(secret) },
    });
    expect(verify.statusCode).toBe(201);
    const token = verify.json<{ token: string }>().token;
    expect(token).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    const disable = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/disable",
      headers: { authorization: `Bearer ${token}` },
      payload: { password, code: totpNow(secret) },
    });
    expect(disable.statusCode).toBe(403);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    expect(login.json<{ mfaRequired: boolean }>().mfaRequired).toBe(true);

    const status = await app.inject({
      method: "GET",
      url: "/api/auth/mfa",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.json()).toMatchObject({ enabled: true, orgRequired: true });
  });

  it("exchanges trusted JWTs for machine tokens", async () => {
    const session = await signup(`jwt-identity-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}/identities`;

    const created = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { name: "workload", role: "viewer", environmentIds: [session.devId] },
    });
    expect(created.statusCode).toBe(201);
    const identity = created.json<{ identity: { id: string; clientId: string } }>().identity;

    const method = await app.inject({
      method: "POST",
      url: `${base}/${identity.id}/auth-methods`,
      headers: auth,
      payload: {
        issuer: idpIssuer,
        audience: "opensiel-workload",
        jwksUri: `${idpIssuer}/jwks`,
        allowedSubjects: ["workload-1"],
      },
    });
    expect(method.statusCode).toBe(201);

    async function sign(subject: string, audience: string): Promise<string> {
      return new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setSubject(subject)
        .setIssuer(idpIssuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(idpPrivateKey);
    }

    const exchanged = await app.inject({
      method: "POST",
      url: "/api/auth/token/jwt",
      payload: {
        clientId: identity.clientId,
        jwt: await sign("workload-1", "opensiel-workload"),
      },
    });
    expect(exchanged.statusCode).toBe(200);
    const machineToken = exchanged.json<{ accessToken: string }>().accessToken;

    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/secrets?env=dev`,
      headers: { authorization: `Bearer ${machineToken}` },
    });
    expect(read.statusCode).toBe(200);

    for (const candidate of [
      await sign("workload-1", "other-audience"),
      await sign("workload-2", "opensiel-workload"),
    ]) {
      const denied = await app.inject({
        method: "POST",
        url: "/api/auth/token/jwt",
        payload: { clientId: identity.clientId, jwt: candidate },
      });
      expect(denied.statusCode).toBe(401);
    }

    const listed = await app.inject({
      method: "GET",
      url: `${base}/${identity.id}/auth-methods`,
      headers: auth,
    });
    expect(listed.json<{ methods: unknown[] }>().methods).toHaveLength(1);
  });

  it("exchanges AWS signed requests for machine tokens", async () => {
    const session = await signup(`aws-identity-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}/identities`;

    const created = await app.inject({
      method: "POST",
      url: base,
      headers: auth,
      payload: { name: "aws", role: "viewer", environmentIds: [session.devId] },
    });
    expect(created.statusCode).toBe(201);
    const identity = created.json<{
      identity: { id: string; clientId: string; clientSecret: string };
    }>().identity;

    const method = await app.inject({
      method: "POST",
      url: `${base}/${identity.id}/auth-methods`,
      headers: auth,
      payload: {
        type: "aws",
        allowedArns: ["arn:aws:iam::123456789012:role/ci-deploy"],
      },
    });
    expect(method.statusCode).toBe(201);
    expect(method.json<{ method: { allowedArns: string[] } }>().method.allowedArns).toEqual([
      "arn:aws:iam::123456789012:role/ci-deploy",
    ]);

    const amzDate = (offsetMs = 0) =>
      new Date(Date.now() + offsetMs)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")
        .replace(/[-:]/g, "");
    const authorizationHeader = (signature: string) =>
      `AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/${new Date()
        .toISOString()
        .slice(0, 10)
        .replace(
          /-/g,
          "",
        )}/us-east-1/sts/aws4_request, SignedHeaders=host;x-amz-date, Signature=${signature}`;

    stsArn = "arn:aws:sts::123456789012:assumed-role/ci-deploy/session-1";
    const signature = "a".repeat(64);
    const payload = {
      clientId: identity.clientId,
      authorization: authorizationHeader(signature),
      amzDate: amzDate(),
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/token/aws",
      payload,
    });
    expect(first.statusCode).toBe(200);
    const machineToken = first.json<{ accessToken: string }>().accessToken;

    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${session.projectId}/secrets?env=dev`,
      headers: { authorization: `Bearer ${machineToken}` },
    });
    expect(read.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/token/aws",
      payload,
    });
    expect(replay.statusCode).toBe(401);

    const stale = await app.inject({
      method: "POST",
      url: "/api/auth/token/aws",
      payload: {
        clientId: identity.clientId,
        authorization: authorizationHeader("b".repeat(64)),
        amzDate: amzDate(-10 * 60_000),
      },
    });
    expect(stale.statusCode).toBe(401);

    stsArn = "arn:aws:iam::999999999999:role/other";
    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/token/aws",
      payload: {
        clientId: identity.clientId,
        authorization: authorizationHeader("c".repeat(64)),
        amzDate: amzDate(),
      },
    });
    expect(denied.statusCode).toBe(401);

    const universal = await app.inject({
      method: "POST",
      url: "/api/auth/token/universal",
      payload: { clientId: identity.clientId, clientSecret: identity.clientSecret },
    });
    expect(universal.statusCode).toBe(200);
  });

  it("rotates a secret and revokes the previous credential after grace", async () => {
    const session = await signup(`rotation-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}`;
    const hookBase = hookUrl.replace(/\/hook$/, "");
    rotationCalls.created.length = 0;
    rotationCalls.revoked.length = 0;

    await app.inject({
      method: "POST",
      url: `${base}/secrets`,
      headers: auth,
      payload: { key: "ROTATE_ME", value: "initial", env: "dev" },
    });

    const created = await app.inject({
      method: "POST",
      url: `${base}/rotations`,
      headers: auth,
      payload: {
        key: "ROTATE_ME",
        env: "dev",
        provider: "http",
        config: {
          createUrl: `${hookBase}/rotate/create`,
          revokeUrl: `${hookBase}/rotate/revoke`,
        },
        intervalSeconds: 3600,
        graceSeconds: 300,
      },
    });
    expect(created.statusCode).toBe(201);
    const rotation = created.json<{ rotation: { id: string } }>().rotation;

    const first = await app.inject({
      method: "POST",
      url: `${base}/rotations/${rotation.id}/rotate`,
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ result: { status: string } }>().result.status).toBe("success");

    const afterFirst = await app.inject({
      method: "GET",
      url: `${base}/secrets/ROTATE_ME?env=dev`,
      headers: auth,
    });
    expect(afterFirst.json<{ secret: { value: string } }>().secret.value).toBe("rotated-value-1");
    expect(rotationCalls.created[0]).toMatchObject({
      key: "ROTATE_ME",
      environment: "dev",
    });
    expect(rotationCalls.revoked).toHaveLength(0);

    const second = await app.inject({
      method: "POST",
      url: `${base}/rotations/${rotation.id}/rotate`,
      headers: auth,
    });
    expect(second.statusCode).toBe(200);
    const afterSecond = await app.inject({
      method: "GET",
      url: `${base}/secrets/ROTATE_ME?env=dev`,
      headers: auth,
    });
    expect(afterSecond.json<{ secret: { value: string } }>().secret.value).toBe("rotated-value-2");
    expect(rotationCalls.revoked).toHaveLength(0);

    await database.sql`
      update rotation_policies
      set previous_revoke_after = now() - interval '1 second'
      where id = ${rotation.id}
    `;
    const revoked = await revokeExpiredRotationCredentials({
      env,
      db: database.db,
      sql: database.sql,
    });
    expect(revoked).toBe(1);
    expect(rotationCalls.revoked[0]).toMatchObject({ credentialId: "cred-1" });
  });

  it("rotates a PostgreSQL role password with dual-phase credentials", async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    const session = await signup(`rotation-pg-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}`;

    await database.sql`drop role if exists rot_a`;
    await database.sql`drop role if exists rot_b`;
    await database.sql`create role rot_a login password 'initial-a'`;
    await database.sql`create role rot_b login password 'initial-b'`;

    const connect = async (username: string, password: string) => {
      const url = new URL(databaseUrl);
      url.username = username;
      url.password = password;
      const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
      try {
        await client`select 1`;
        return true;
      } finally {
        await client.end({ timeout: 5 });
      }
    };

    try {
      const created = await app.inject({
        method: "POST",
        url: `${base}/rotations`,
        headers: auth,
        payload: {
          key: "PG_CREDENTIAL",
          env: "dev",
          provider: "postgres",
          config: {
            adminUrl: databaseUrl,
            username: "rot_a",
            alternateUsername: "rot_b",
          },
          intervalSeconds: 3600,
          graceSeconds: 300,
        },
      });
      expect(created.statusCode).toBe(201);
      const rotation = created.json<{ rotation: { id: string } }>().rotation;

      const first = await app.inject({
        method: "POST",
        url: `${base}/rotations/${rotation.id}/rotate`,
        headers: auth,
      });
      expect(first.json<{ result: { status: string } }>().result.status).toBe("success");

      const afterFirst = await app.inject({
        method: "GET",
        url: `${base}/secrets/PG_CREDENTIAL?env=dev`,
        headers: auth,
      });
      const firstValue = afterFirst.json<{ secret: { value: string } }>().secret.value;
      const [firstUser, firstPassword] = firstValue.split(":");
      expect(firstUser).toBe("rot_a");
      expect(await connect(firstUser, firstPassword)).toBe(true);

      const second = await app.inject({
        method: "POST",
        url: `${base}/rotations/${rotation.id}/rotate`,
        headers: auth,
      });
      expect(second.json<{ result: { status: string } }>().result.status).toBe("success");

      const afterSecond = await app.inject({
        method: "GET",
        url: `${base}/secrets/PG_CREDENTIAL?env=dev`,
        headers: auth,
      });
      const secondValue = afterSecond.json<{ secret: { value: string } }>().secret.value;
      const [secondUser, secondPassword] = secondValue.split(":");
      expect(secondUser).toBe("rot_b");
      expect(await connect(secondUser, secondPassword)).toBe(true);

      await database.sql`
        update rotation_policies
        set previous_revoke_after = now() - interval '1 second'
        where id = ${rotation.id}
      `;
      const revoked = await revokeExpiredRotationCredentials({
        env,
        db: database.db,
        sql: database.sql,
      });
      expect(revoked).toBe(1);
      await expect(connect(firstUser, firstPassword)).rejects.toThrow();
    } finally {
      await database.sql`drop role if exists rot_a`;
      await database.sql`drop role if exists rot_b`;
    }
  });

  it("grants scoped custom-role permissions with temporary access", async () => {
    const owner = await signup(`rbac-owner-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${owner.token}` };
    const viewerEmail = `rbac-viewer-${Date.now()}@test.dev`;

    const invite = await app.inject({
      method: "POST",
      url: "/api/org/invites",
      headers: auth,
      payload: { email: viewerEmail, role: "viewer" },
    });
    expect(invite.statusCode).toBe(201);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: {
        token: invite.json<{ token: string }>().token,
        name: "Viewer",
        password: "viewer-password-123",
      },
    });
    expect(accepted.statusCode).toBe(201);
    const viewer = accepted.json<{ token: string; user: { id: string } }>();
    const viewerAuth = { authorization: `Bearer ${viewer.token}` };

    const denied = await app.inject({
      method: "POST",
      url: `/api/projects/${owner.projectId}/secrets`,
      headers: viewerAuth,
      payload: { key: "RBAC_KEY", value: "x", env: "dev" },
    });
    expect(denied.statusCode).toBe(403);

    const roleResponse = await app.inject({
      method: "POST",
      url: "/api/org/roles",
      headers: auth,
      payload: { name: "dev-writer", permissions: ["secret:write"] },
    });
    expect(roleResponse.statusCode).toBe(201);
    const role = roleResponse.json<{ role: { id: string } }>().role;

    const grant = await app.inject({
      method: "POST",
      url: "/api/org/grants",
      headers: auth,
      payload: {
        userId: viewer.user.id,
        roleId: role.id,
        environmentId: owner.devId,
        path: "/",
      },
    });
    expect(grant.statusCode).toBe(201);
    const grantId = grant.json<{ grant: { id: string } }>().grant.id;

    const allowed = await app.inject({
      method: "POST",
      url: `/api/projects/${owner.projectId}/secrets`,
      headers: viewerAuth,
      payload: { key: "RBAC_KEY", value: "x", env: "dev" },
    });
    expect(allowed.statusCode).toBe(201);

    for (const payload of [
      { key: "RBAC_KEY", value: "x", env: "prod" },
      { key: "RBAC_KEY", value: "x", env: "dev", path: "/backend" },
    ]) {
      const outside = await app.inject({
        method: "POST",
        url: `/api/projects/${owner.projectId}/secrets`,
        headers: viewerAuth,
        payload,
      });
      expect(outside.statusCode).toBe(403);
    }

    await database.sql`
      update role_grants set expires_at = now() - interval '1 minute' where id = ${grantId}
    `;
    const expired = await app.inject({
      method: "POST",
      url: `/api/projects/${owner.projectId}/secrets`,
      headers: viewerAuth,
      payload: { key: "RBAC_KEY", value: "y", env: "dev" },
    });
    expect(expired.statusCode).toBe(403);
  });

  it("syncs environment secrets to a webhook provider and records failures", async () => {
    const session = await signup(`sync-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}`;
    const hookBase = hookUrl.replace(/\/hook$/, "");
    syncBodies.length = 0;
    syncFail = false;

    await app.inject({
      method: "POST",
      url: `${base}/secrets`,
      headers: auth,
      payload: { key: "ROOT_KEY", value: "root-value", env: "dev" },
    });
    await app.inject({
      method: "POST",
      url: `${base}/secrets`,
      headers: auth,
      payload: { key: "FOLDER_KEY", value: "folder-value", env: "dev", path: "/backend" },
    });

    const created = await app.inject({
      method: "POST",
      url: `${base}/syncs`,
      headers: auth,
      payload: {
        env: "dev",
        path: "/",
        provider: "webhook",
        config: { url: `${hookBase}/sync-target` },
        intervalSeconds: 300,
      },
    });
    expect(created.statusCode).toBe(201);
    const sync = created.json<{ sync: { id: string } }>().sync;

    const run = await app.inject({
      method: "POST",
      url: `${base}/syncs/${sync.id}/run`,
      headers: auth,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json<{ result: { status: string; count: number } }>().result).toMatchObject({
      status: "success",
      count: 1,
    });
    expect(syncBodies).toHaveLength(1);
    expect(syncBodies[0]).toMatchObject({
      environment: "dev",
      path: "/",
      secrets: { ROOT_KEY: "root-value" },
    });
    expect(JSON.stringify(syncBodies[0])).not.toContain("folder-value");

    syncFail = true;
    const failed = await app.inject({
      method: "POST",
      url: `${base}/syncs/${sync.id}/run`,
      headers: auth,
    });
    expect(failed.json<{ result: { status: string } }>().result.status).toBe("error");
    syncFail = false;

    const rows = await database.sql<
      { failure_count: number; last_status: string; last_error: string }[]
    >`select failure_count, last_status, last_error from secret_syncs where id = ${sync.id}`;
    expect(rows[0]).toMatchObject({ failure_count: 1, last_status: "error" });

    const listed = await app.inject({
      method: "GET",
      url: `${base}/syncs`,
      headers: auth,
    });
    expect(listed.json<{ syncs: { lastStatus: string }[] }>().syncs[0].lastStatus).toBe("error");
  });

  it("syncs secrets to a Kubernetes Secret", async () => {
    const session = await signup(`sync-kube-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}`;
    const hookBase = hookUrl.replace(/\/hook$/, "");
    kubeSecrets.clear();

    await app.inject({
      method: "POST",
      url: `${base}/secrets`,
      headers: auth,
      payload: { key: "K8S_KEY", value: "kube-value", env: "dev" },
    });

    const created = await app.inject({
      method: "POST",
      url: `${base}/syncs`,
      headers: auth,
      payload: {
        env: "dev",
        path: "/",
        provider: "kubernetes",
        config: {
          apiUrl: hookBase,
          token: "test-token",
          namespace: "apps",
          secretName: "app-secrets",
        },
        intervalSeconds: 300,
      },
    });
    expect(created.statusCode).toBe(201);
    const sync = created.json<{ sync: { id: string } }>().sync;

    const run = await app.inject({
      method: "POST",
      url: `${base}/syncs/${sync.id}/run`,
      headers: auth,
    });
    expect(run.json<{ result: { status: string; count: number } }>().result).toMatchObject({
      status: "success",
      count: 1,
    });

    const stored = kubeSecrets.get("app-secrets");
    expect(stored).toBeTruthy();
    expect(Buffer.from(stored!.K8S_KEY, "base64").toString("utf8")).toBe("kube-value");
  });

  it("stores end-to-end encrypted secrets without server plaintext", async () => {
    const session = await signup(`e2ee-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const base = `/api/projects/${session.projectId}`;

    const mode = await app.inject({
      method: "PATCH",
      url: `${base}/encryption`,
      headers: auth,
      payload: { mode: "e2ee" },
    });
    expect(mode.statusCode).toBe(200);

    const kdf = { t: 1, m: 1024, p: 1, dkLen: 32 };
    const identity = generateIdentity("e2ee-password-123", kdf);
    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/auth/keys",
      headers: auth,
      payload: {
        publicKey: identity.publicKey,
        wrappedPrivateKey: identity.wrappedPrivateKey.ciphertext,
        privateKeyIv: identity.wrappedPrivateKey.iv,
        privateKeyTag: identity.wrappedPrivateKey.tag,
        kdfSalt: identity.wrappedPrivateKey.salt,
        kdfParams: identity.wrappedPrivateKey.kdf,
      },
    });
    expect(uploaded.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth });
    const userId = me.json<{ user: { id: string } }>().user.id;

    const projectKey = generateProjectKey();
    const wrapped = wrapProjectKey(projectKey, identity.publicKey);
    const keysUpload = await app.inject({
      method: "PUT",
      url: `${base}/keys`,
      headers: auth,
      payload: { keys: [{ userId, ...wrapped, keyVersion: 1 }] },
    });
    expect(keysUpload.statusCode).toBe(200);

    const aad = secretAad(session.projectId, "dev", "/", "E2EE_KEY");
    const payload = encryptSecret(projectKey, "server-never-sees-this", aad);
    const written = await app.inject({
      method: "POST",
      url: `${base}/secrets/ciphertext`,
      headers: auth,
      payload: {
        env: "dev",
        key: "E2EE_KEY",
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        tag: payload.tag,
        keyVersion: 1,
      },
    });
    expect(written.statusCode).toBe(201);
    expect(written.json<{ secret: { version: number } }>().secret.version).toBe(1);

    const listed = await app.inject({
      method: "GET",
      url: `${base}/secrets/ciphertext?env=dev`,
      headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    const secrets = listed.json<{
      secrets: { key: string; ciphertext: string; iv: string; tag: string }[];
    }>().secrets;
    expect(secrets).toHaveLength(1);
    expect(secrets[0].key).toBe("E2EE_KEY");
    expect(secrets[0].ciphertext).not.toContain("server-never-sees-this");
    expect(
      decryptSecret(
        projectKey,
        { ciphertext: secrets[0].ciphertext, iv: secrets[0].iv, tag: secrets[0].tag },
        aad,
      ),
    ).toBe("server-never-sees-this");

    const keys = await app.inject({
      method: "GET",
      url: `${base}/keys`,
      headers: auth,
    });
    const keysBody = keys.json<{
      mode: string;
      key: { wrappedKey: string; iv: string; tag: string };
      members: { userId: string; publicKey: string }[];
    }>();
    expect(keysBody.mode).toBe("e2ee");
    expect(
      keysBody.members.some(
        (member) => member.userId === userId && member.publicKey === identity.publicKey,
      ),
    ).toBe(true);
    const unlocked = unlockIdentity("e2ee-password-123", identity.wrappedPrivateKey);
    expect(unwrapProjectKey(unlocked.privateKey, keysBody.key)).toBe(projectKey);

    const plainRead = await app.inject({
      method: "GET",
      url: `${base}/secrets?env=dev`,
      headers: auth,
    });
    expect(plainRead.statusCode).toBe(409);
    expect(plainRead.json<{ error: string }>().error).toBe("feature_unavailable_in_e2ee");

    const plainWrite = await app.inject({
      method: "POST",
      url: `${base}/secrets`,
      headers: auth,
      payload: { key: "NOPE", value: "x", env: "dev" },
    });
    expect(plainWrite.statusCode).toBe(409);

    const switchBack = await app.inject({
      method: "PATCH",
      url: `${base}/encryption`,
      headers: auth,
      payload: { mode: "server" },
    });
    expect(switchBack.statusCode).toBe(409);
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

    const admin = await inviteAndAccept(owner.token, `approver-${Date.now()}@test.dev`, "admin");
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
    expect(applied.json<{ secrets: { key: string; value: string }[] }>().secrets[0]).toMatchObject({
      key: "TWO_MAN",
      value: "value",
    });
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
      audit.json<{ logs: { action: string }[] }>().logs.some((log) => log.action === "secret.scan"),
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

  it("supports custom environments such as UAT", async () => {
    const session = await signup(`envs-${Date.now()}@test.dev`);
    const auth = { authorization: `Bearer ${session.token}` };
    const projectId = session.projectId;

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/environments`,
      headers: auth,
      payload: { name: "UAT" },
    });
    expect(created.statusCode).toBe(201);
    const environment = created.json<{
      environment: { id: string; slug: string; position: number };
    }>().environment;
    expect(environment.slug).toBe("uat");
    expect(environment.position).toBe(3);

    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
      headers: auth,
    });
    expect(list.json<{ environments: unknown[] }>().environments).toHaveLength(4);

    const set = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/secrets`,
      headers: auth,
      payload: { env: "uat", key: "UAT_API_KEY", value: "uat-value" },
    });
    expect(set.statusCode).toBe(201);
    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/secrets?env=uat`,
      headers: auth,
    });
    expect(
      read
        .json<{ secrets: { key: string; value: string }[] }>()
        .secrets.find((secret) => secret.key === "UAT_API_KEY")?.value,
    ).toBe("uat-value");

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${environment.id}`,
      headers: auth,
    });
    expect(blocked.statusCode).toBe(409);

    const viewer = await inviteAndAccept(
      session.token,
      `env-viewer-${Date.now()}@test.dev`,
      "viewer",
    );
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/environments`,
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { name: "QA" },
    });
    expect(forbidden.statusCode).toBe(403);

    await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/secrets/UAT_API_KEY?env=uat`,
      headers: auth,
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${environment.id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(200);
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
      readable
        .json<{ secrets: { key: string; value: string }[] }>()
        .secrets.find((secret) => secret.key === "ROTATE_ME")?.value,
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
      afterRestart
        .json<{ secrets: { key: string; value: string }[] }>()
        .secrets.find((secret) => secret.key === "ROTATE_ME")?.value,
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
