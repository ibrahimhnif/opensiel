import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import type { Env } from "./env.js";

/**
 * Resolves the master key. With KMS configured, the wrapped key is decrypted once
 * at startup so the rest of the application keeps using an in-memory key.
 */
export async function resolveMasterKey(env: Env): Promise<Buffer> {
  if (!env.kms) {
    if (env.masterKey.length !== 32) {
      throw new Error("master key is not configured");
    }
    return env.masterKey;
  }

  const client = new KMSClient({
    region: env.kms.region,
    endpoint: env.kms.endpoint,
    credentials:
      env.kms.accessKeyId && env.kms.secretAccessKey
        ? {
            accessKeyId: env.kms.accessKeyId,
            secretAccessKey: env.kms.secretAccessKey,
          }
        : undefined,
  });

  const result = await client.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(env.kms.wrappedKey, "base64"),
      KeyId: env.kms.keyId,
    }),
  );

  if (!result.Plaintext) {
    throw new Error("AWS KMS returned no plaintext for the wrapped master key");
  }
  const key = Buffer.from(result.Plaintext);
  if (key.length !== 32) {
    throw new Error("the KMS-decrypted master key must be exactly 32 bytes");
  }
  return key;
}
