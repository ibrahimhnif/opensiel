import { describe, expect, it } from "vitest";
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

const KDF = { t: 1, m: 1024, p: 1, dkLen: 32 };

describe("e2ee identity keys", () => {
  it("wraps and unlocks a private key with the password", () => {
    const identity = generateIdentity("correct horse battery", KDF);
    const unlocked = unlockIdentity("correct horse battery", {
      ...identity.wrappedPrivateKey,
    });
    expect(unlocked.publicKey).toBe(identity.publicKey);
    expect(unlocked.privateKey.length).toBe(32);
    expect(() => unlockIdentity("wrong password", identity.wrappedPrivateKey)).toThrow();
  });
});

describe("e2ee project keys", () => {
  it("wraps a project key for a member and rejects other keys", () => {
    const identity = generateIdentity("password-one", KDF);
    const other = generateIdentity("password-two", KDF);
    const projectKey = generateProjectKey();
    const wrapped = wrapProjectKey(projectKey, identity.publicKey);

    const unlocked = unlockIdentity("password-one", identity.wrappedPrivateKey);
    expect(wrapProjectKey(projectKey, other.publicKey).wrappedKey).not.toBe(wrapped.wrappedKey);
    expect(unwrapProjectKey(unlocked.privateKey, wrapped)).toBe(projectKey);

    const otherUnlocked = unlockIdentity("password-two", other.wrappedPrivateKey);
    expect(() => unwrapProjectKey(otherUnlocked.privateKey, wrapped)).toThrow();
  });
});

describe("e2ee secret payloads", () => {
  it("round-trips with AAD and rejects a different AAD", () => {
    const projectKey = generateProjectKey();
    const aad = secretAad("project-1", "dev", "/", "DATABASE_URL");
    const payload = encryptSecret(projectKey, "postgres://secret", aad);
    expect(decryptSecret(projectKey, payload, aad)).toBe("postgres://secret");

    const otherAad = secretAad("project-1", "prod", "/", "DATABASE_URL");
    expect(() => decryptSecret(projectKey, payload, otherAad)).toThrow();
  });
});
