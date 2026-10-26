import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  currentTotpStep,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  totpCode,
  verifyTotp,
} from "../src/mfa.js";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("base32", () => {
  it("round-trips random bytes", () => {
    const buffer = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(buffer)).equals(buffer)).toBe(true);
  });

  it("encodes the RFC 6238 secret", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("totp", () => {
  it("matches RFC 6238 SHA-1 vectors", () => {
    expect(totpCode(RFC_SECRET, 1, 8)).toBe("94287082");
    expect(totpCode(RFC_SECRET, 37037036, 8)).toBe("07081804");
    expect(totpCode(RFC_SECRET, 37037037, 8)).toBe("14050471");
  });

  it("accepts the current code and rejects others", () => {
    const secret = base32Encode(RFC_SECRET);
    const at = 1_111_111_111_000;
    const code = totpCode(RFC_SECRET, currentTotpStep(at));
    expect(verifyTotp(secret, code, at)).toBe(currentTotpStep(at));
    expect(verifyTotp(secret, "000000", at)).toBeNull();
  });
});

describe("recovery codes", () => {
  it("generates unambiguous codes and normalizes input", () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
    expect(normalizeRecoveryCode(" abcd-efgh ")).toBe("ABCDEFGH");
  });
});
