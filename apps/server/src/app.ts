import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { AppError } from "./errors.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerOrgRoutes } from "./routes/org.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSecretRoutes } from "./routes/secrets.js";
import { registerIdentityRoutes } from "./routes/identities.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerOidcRoutes } from "./routes/oidc.js";
import { registerScanRoutes } from "./routes/scan.js";
import { registerDynamicRoutes } from "./routes/dynamic.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerSamlRoutes } from "./routes/saml.js";
import type { Deps } from "./types.js";

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      deps.env.nodeEnv === "test"
        ? false
        : {
            level: deps.env.isProd ? "info" : "debug",
            redact: ["req.headers.authorization", "req.headers.cookie"],
          },
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cookie);

  if (deps.env.rateLimit) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: "1 minute",
      allowList: [],
    });
  }

  app.addContentTypeParser(
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

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
  });

  app.get("/api/health", async (_request, reply) => {
    try {
      await deps.sql`select 1`;
      return { status: "ok", version: "0.1.0", time: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: "degraded", version: "0.1.0" });
    }
  });

  registerAuthRoutes(app, deps);
  registerOrgRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerSecretRoutes(app, deps);
  registerIdentityRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerOidcRoutes(app, deps);
  registerScanRoutes(app, deps);
  registerDynamicRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerSamlRoutes(app, deps);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: "bad_request", message: (error as Error).message });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "internal server error" });
  });

  const webDir = deps.env.webDir ? resolve(process.cwd(), deps.env.webDir) : undefined;
  const serveWeb = Boolean(webDir && existsSync(resolve(webDir, "index.html")));
  const docsDir = webDir ? resolve(webDir, "docs") : undefined;
  const serveDocs = Boolean(docsDir && existsSync(resolve(docsDir, "index.html")));

  function findDocsFile(rawUrl: string): string | undefined {
    if (!docsDir) return undefined;
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawUrl.split("?")[0] ?? "/");
    } catch {
      return undefined;
    }
    if (pathname === "/docs") pathname = "/docs/";
    if (!pathname.startsWith("/docs/")) return undefined;
    const relative = pathname.slice("/docs/".length).replace(/\/+$/, "");
    const candidates = relative
      ? [relative, `${relative}.html`, `${relative}/index.html`]
      : ["index.html"];
    for (const candidate of candidates) {
      const absolute = resolve(docsDir, candidate);
      if (absolute !== docsDir && !absolute.startsWith(`${docsDir}/`)) continue;
      if (absolute.endsWith(".html") && existsSync(absolute)) {
        return `docs/${candidate}`;
      }
    }
    return undefined;
  }

  if (serveWeb && webDir) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: "/",
      decorateReply: true,
      index: ["index.html"],
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found", message: "route not found" });
    }
    if (serveDocs && request.method === "GET" && request.url.startsWith("/docs")) {
      const file = findDocsFile(request.url);
      if (file) return reply.sendFile(file);
      return reply.code(404).sendFile("docs/404.html");
    }
    if (serveWeb && request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not_found", message: "not found" });
  });

  return app;
}
