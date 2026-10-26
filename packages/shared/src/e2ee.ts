import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

declare const btoa: (input: string) => string;
declare const atob: (input: string) => string;

const INFO_WRAP = new TextEncoder().encode("opensiel-e2ee-wrap-v1");
const TAG_LENGTH = 16;

export interface KdfParams {
  t: number;
  m: number;
  p: number;
  dkLen: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { t: 3, m: 65536, p: 1, dkLen: 32 };

export interface WrappedPrivateKey {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
  kdf: KdfParams;
}

export interface IdentityKeypair {
  publicKey: string;
  wrappedPrivateKey: WrappedPrivateKey;
}

export interface WrappedProjectKey {
  wrappedKey: string;
  iv: string;
  tag: string;
}

export interface E2eePayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function deriveKey(password: string, salt: Uint8Array, params: KdfParams): Uint8Array {
  return argon2id(new TextEncoder().encode(password.normalize("NFKC")), salt, params);
}

function split(sealed: Uint8Array): { ciphertext: Uint8Array; tag: Uint8Array } {
  return {
    ciphertext: sealed.slice(0, -TAG_LENGTH),
    tag: sealed.slice(-TAG_LENGTH),
  };
}

function join(ciphertext: Uint8Array, tag: Uint8Array): Uint8Array {
  const out = new Uint8Array(ciphertext.length + tag.length);
  out.set(ciphertext, 0);
  out.set(tag, ciphertext.length);
  return out;
}

export function generateIdentity(
  password: string,
  kdf: KdfParams = DEFAULT_KDF_PARAMS,
): IdentityKeypair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const salt = randomBytes(16);
  const key = deriveKey(password, salt, kdf);
  const iv = randomBytes(12);
  const sealed = gcm(key, iv).encrypt(privateKey);
  const { ciphertext, tag } = split(sealed);

  return {
    publicKey: toBase64(publicKey),
    wrappedPrivateKey: {
      ciphertext: toBase64(ciphertext),
      iv: toBase64(iv),
      tag: toBase64(tag),
      salt: toBase64(salt),
      kdf,
    },
  };
}

export function unlockIdentity(
  password: string,
  wrapped: WrappedPrivateKey,
): { privateKey: Uint8Array; publicKey: string } {
  const key = deriveKey(password, fromBase64(wrapped.salt), wrapped.kdf);
  const sealed = join(fromBase64(wrapped.ciphertext), fromBase64(wrapped.tag));
  const privateKey = gcm(key, fromBase64(wrapped.iv)).decrypt(sealed);
  return {
    privateKey,
    publicKey: toBase64(x25519.getPublicKey(privateKey)),
  };
}

export function generateProjectKey(): string {
  return toBase64(randomBytes(32));
}

export function wrapProjectKey(projectKey: string, recipientPublicKey: string): WrappedProjectKey {
  const recipient = fromBase64(recipientPublicKey);
  const ephemeralPrivate = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  const shared = x25519.getSharedSecret(ephemeralPrivate, recipient);
  const wrapKey = hkdf(sha256, shared, ephemeralPublic, INFO_WRAP, 32);
  const iv = randomBytes(12);
  const sealed = gcm(wrapKey, iv, new TextEncoder().encode(recipientPublicKey)).encrypt(
    fromBase64(projectKey),
  );
  const { ciphertext, tag } = split(sealed);

  const wrapped = new Uint8Array(ephemeralPublic.length + ciphertext.length);
  wrapped.set(ephemeralPublic, 0);
  wrapped.set(ciphertext, ephemeralPublic.length);

  return {
    wrappedKey: toBase64(wrapped),
    iv: toBase64(iv),
    tag: toBase64(tag),
  };
}

export function unwrapProjectKey(privateKey: Uint8Array, wrapped: WrappedProjectKey): string {
  const raw = fromBase64(wrapped.wrappedKey);
  if (raw.length <= 32) throw new Error("invalid wrapped key");
  const ephemeralPublic = raw.slice(0, 32);
  const ciphertext = raw.slice(32);
  const publicKey = toBase64(x25519.getPublicKey(privateKey));
  const shared = x25519.getSharedSecret(privateKey, ephemeralPublic);
  const wrapKey = hkdf(sha256, shared, ephemeralPublic, INFO_WRAP, 32);
  const sealed = join(ciphertext, fromBase64(wrapped.tag));
  const projectKey = gcm(
    wrapKey,
    fromBase64(wrapped.iv),
    new TextEncoder().encode(publicKey),
  ).decrypt(sealed);
  return toBase64(projectKey);
}

export function secretAad(
  projectId: string,
  environment: string,
  path: string,
  key: string,
): string {
  return `e2ee:${projectId}:${environment}:${path}:${key}`;
}

export function encryptSecret(projectKey: string, plaintext: string, aad: string): E2eePayload {
  const iv = randomBytes(12);
  const sealed = gcm(fromBase64(projectKey), iv, new TextEncoder().encode(aad)).encrypt(
    new TextEncoder().encode(plaintext),
  );
  const { ciphertext, tag } = split(sealed);
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv), tag: toBase64(tag) };
}

export function decryptSecret(projectKey: string, payload: E2eePayload, aad: string): string {
  const sealed = join(fromBase64(payload.ciphertext), fromBase64(payload.tag));
  const plaintext = gcm(
    fromBase64(projectKey),
    fromBase64(payload.iv),
    new TextEncoder().encode(aad),
  ).decrypt(sealed);
  return new TextDecoder().decode(plaintext);
}
