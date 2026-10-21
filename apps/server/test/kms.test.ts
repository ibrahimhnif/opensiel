import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { resolveMasterKey } from "../src/kms.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");

let server: FastifyInstance;
let endpoint = "";

beforeAll(async () => {
  server = Fastify({ logger: false });
  server.addContentTypeParser(
    "application/x-amz-json-1.1",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  server.post("/", async (request, reply) => {
    if (request.headers["x-amz-target"] !== "TrentService.Decrypt") {
      return reply.code(400).send({ __type: "UnknownOperationException" });
    }
    const body = JSON.parse(request.body as string) as {
      CiphertextBlob: string;
      KeyId: string;
    };
    expect(Buffer.from(body.CiphertextBlob, "base64").toString()).toBe("wrapped-key");
    return reply.type("application/x-amz-json-1.1").send({
      Plaintext: KEY.toString("base64"),
      KeyId: body.KeyId,
    });
  });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await server.close();
});

function baseEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    OPENSIEL_JWT_SECRET: "x".repeat(40),
    ...overrides,
  };
}

describe("master key resolution", () => {
  it("uses OPENSIEL_MASTER_KEY when no KMS is configured", async () => {
    const envKey = Buffer.from("abcdef0123456789abcdef0123456789");
    const env = loadEnv(baseEnv({ OPENSIEL_MASTER_KEY: envKey.toString("base64") }));
    expect(env.kms).toBeUndefined();
    const key = await resolveMasterKey(env);
    expect(key.toString("hex")).toBe(envKey.toString("hex"));
  });

  it("decrypts the wrapped master key with AWS KMS", async () => {
    const env = loadEnv(
      baseEnv({
        OPENSIEL_KMS_KEY_ID: "test-key",
        OPENSIEL_KMS_WRAPPED_MASTER_KEY: Buffer.from("wrapped-key").toString("base64"),
        OPENSIEL_KMS_ENDPOINT: endpoint,
        OPENSIEL_KMS_ACCESS_KEY_ID: "test",
        OPENSIEL_KMS_SECRET_ACCESS_KEY: "test",
      }),
    );
    expect(env.kms).toBeTruthy();
    expect(env.masterKey.length).toBe(0);
    const key = await resolveMasterKey(env);
    expect(key.toString("hex")).toBe(KEY.toString("hex"));
  });

  it("rejects incomplete or invalid key configuration", () => {
    expect(() => loadEnv(baseEnv({ OPENSIEL_KMS_KEY_ID: "only-id" }))).toThrow();
    expect(() => loadEnv(baseEnv({}))).toThrow();
    expect(() =>
      loadEnv(baseEnv({ OPENSIEL_MASTER_KEY: Buffer.from("short").toString("base64") })),
    ).toThrow();
  });
});
