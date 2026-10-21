import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const DEK_AAD = Buffer.from("opensiel:dek:v1");

export interface WrappedKey {
  wrapped: string;
  iv: string;
  tag: string;
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

export function parseMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("master key must be 32 bytes");
  return key;
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function wrapDek(kek: Buffer, dek: Buffer): WrappedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  cipher.setAAD(DEK_AAD);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  return {
    wrapped: wrapped.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function unwrapDek(kek: Buffer, key: WrappedKey): Buffer {
  const decipher = createDecipheriv(ALGORITHM, kek, Buffer.from(key.iv, "base64"));
  decipher.setAAD(DEK_AAD);
  decipher.setAuthTag(Buffer.from(key.tag, "base64"));
  const dek = Buffer.concat([decipher.update(Buffer.from(key.wrapped, "base64")), decipher.final()]);
  if (dek.length !== 32) throw new Error("invalid data key");
  return dek;
}

export function encryptValue(dek: Buffer, plaintext: string, aad: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptValue(dek: Buffer, value: EncryptedValue, aad: string): string {
  const decipher = createDecipheriv(ALGORITHM, dek, Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function secretAad(secretId: string, version: number): string {
  return `${secretId}:${version}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(value: string): string {
  return sha256(value);
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
