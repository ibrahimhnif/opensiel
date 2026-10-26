import { describe, expect, it } from "vitest";
import {
  constantTimeEqualHex,
  decryptValue,
  encryptValue,
  generateDek,
  generateMasterKey,
  parseMasterKey,
  secretAad,
  sha256,
  unwrapDek,
  valueFingerprint,
  wrapDek,
} from "../src/crypto.js";

const kek = parseMasterKey(generateMasterKey());

describe("envelope encryption", () => {
  it("wraps and unwraps a data key", () => {
    const dek = generateDek();
    const wrapped = wrapDek(kek, dek);
    expect(Buffer.from(wrapped.wrapped, "base64").length).toBe(32);
    const unwrapped = unwrapDek(kek, wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("fails to unwrap with a different master key", () => {
    const dek = generateDek();
    const wrapped = wrapDek(kek, dek);
    const other = parseMasterKey(generateMasterKey());
    expect(() => unwrapDek(other, wrapped)).toThrow();
  });

  it("round-trips secret values with AAD binding", () => {
    const dek = generateDek();
    const aad = secretAad("secret-1", 1);
    const encrypted = encryptValue(dek, "postgres://user:pass@host/db", aad);
    expect(decryptValue(dek, encrypted, aad)).toBe("postgres://user:pass@host/db");
  });

  it("rejects a different AAD", () => {
    const dek = generateDek();
    const encrypted = encryptValue(dek, "value", secretAad("secret-1", 1));
    expect(() => decryptValue(dek, encrypted, secretAad("secret-1", 2))).toThrow();
    expect(() => decryptValue(dek, encrypted, secretAad("secret-2", 1))).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const dek = generateDek();
    const aad = secretAad("secret-1", 1);
    const encrypted = encryptValue(dek, "value", aad);
    const buffer = Buffer.from(encrypted.ciphertext, "base64");
    buffer[0] ^= 0xff;
    expect(() =>
      decryptValue(dek, { ...encrypted, ciphertext: buffer.toString("base64") }, aad),
    ).toThrow();
  });

  it("uses a fresh iv per encryption", () => {
    const dek = generateDek();
    const a = encryptValue(dek, "same", "aad");
    const b = encryptValue(dek, "same", "aad");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("hashing helpers", () => {
  it("hashes deterministically", () => {
    expect(sha256("token")).toBe(sha256("token"));
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  it("keys fingerprints so a database dump cannot confirm guesses", () => {
    const dek = generateDek();
    const otherDek = generateDek();
    expect(valueFingerprint(dek, "value")).toBe(valueFingerprint(dek, "value"));
    expect(valueFingerprint(dek, "value")).not.toBe(valueFingerprint(otherDek, "value"));
    expect(valueFingerprint(dek, "value")).not.toBe(sha256("value"));
  });

  it("compares in constant time", () => {
    expect(constantTimeEqualHex(sha256("x"), sha256("x"))).toBe(true);
    expect(constantTimeEqualHex(sha256("x"), sha256("y"))).toBe(false);
    expect(constantTimeEqualHex("abc", "abcdef")).toBe(false);
  });

  it("rejects malformed master keys", () => {
    expect(() => parseMasterKey(Buffer.from("short").toString("base64"))).toThrow();
  });
});
