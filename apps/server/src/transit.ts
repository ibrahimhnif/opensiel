import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { TransitKeyDto } from "@opensiel/shared";
import { projectDek } from "./access.js";
import { decryptValue, encryptValue, generateDek } from "./crypto.js";
import type { EncryptedValue } from "./crypto.js";
import { AppError, conflict } from "./errors.js";
import { transitKeys } from "./db/schema.js";
import type { ProjectRow, TransitKeyRow } from "./db/schema.js";
import type { Deps } from "./types.js";

const ENVELOPE_PREFIX = "osl1";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function keyAad(projectId: string, name: string, version: number): string {
  return `transit-key:${projectId}:${name}:${version}`;
}

function dataAad(projectId: string, name: string, version: number, context: string): string {
  return `transit:${projectId}:${name}:${version}:${context}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

function toKeyDto(row: TransitKeyRow): TransitKeyDto {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function latestTransitKey(
  deps: Deps,
  projectId: string,
  name: string,
): Promise<TransitKeyRow | undefined> {
  const rows = await deps.db
    .select()
    .from(transitKeys)
    .where(and(eq(transitKeys.projectId, projectId), eq(transitKeys.name, name)))
    .orderBy(desc(transitKeys.version))
    .limit(1);
  return rows[0];
}

async function getTransitKey(
  deps: Deps,
  projectId: string,
  name: string,
  version: number,
): Promise<TransitKeyRow | undefined> {
  const rows = await deps.db
    .select()
    .from(transitKeys)
    .where(
      and(
        eq(transitKeys.projectId, projectId),
        eq(transitKeys.name, name),
        eq(transitKeys.version, version),
      ),
    )
    .limit(1);
  return rows[0];
}

async function insertTransitKey(
  deps: Deps,
  project: ProjectRow,
  name: string,
  version: number,
): Promise<TransitKeyRow> {
  const id = randomUUID();
  const material = generateDek();
  const wrapped = encryptValue(
    projectDek(deps, project),
    material.toString("base64"),
    keyAad(project.id, name, version),
  );

  try {
    const rows = await deps.db
      .insert(transitKeys)
      .values({
        id,
        projectId: project.id,
        name,
        version,
        wrapped: wrapped.ciphertext,
        iv: wrapped.iv,
        tag: wrapped.tag,
      })
      .returning();
    return rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await getTransitKey(deps, project.id, name, version);
      if (existing) return existing;
    }
    throw error;
  }
}

export async function ensureTransitKey(
  deps: Deps,
  project: ProjectRow,
  name: string,
): Promise<TransitKeyRow> {
  const existing = await latestTransitKey(deps, project.id, name);
  if (existing) return existing;
  return insertTransitKey(deps, project, name, 1);
}

export async function createTransitKey(
  deps: Deps,
  project: ProjectRow,
  name: string,
): Promise<TransitKeyDto> {
  const existing = await latestTransitKey(deps, project.id, name);
  if (existing) throw conflict("transit key already exists");
  return toKeyDto(await insertTransitKey(deps, project, name, 1));
}

export async function rotateTransitKey(
  deps: Deps,
  project: ProjectRow,
  name: string,
): Promise<TransitKeyDto> {
  const current = await latestTransitKey(deps, project.id, name);
  const version = (current?.version ?? 0) + 1;
  return toKeyDto(await insertTransitKey(deps, project, name, version));
}

export async function listTransitKeys(deps: Deps, projectId: string): Promise<TransitKeyDto[]> {
  const rows = await deps.db
    .select()
    .from(transitKeys)
    .where(eq(transitKeys.projectId, projectId))
    .orderBy(desc(transitKeys.version));
  const latest = new Map<string, TransitKeyRow>();
  for (const row of rows) {
    if (!latest.has(row.name)) latest.set(row.name, row);
  }
  return Array.from(latest.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toKeyDto);
}

export function encodeTransitCiphertext(
  name: string,
  version: number,
  value: EncryptedValue,
): string {
  return [ENVELOPE_PREFIX, name, String(version), value.iv, value.tag, value.ciphertext].join(".");
}

export interface DecodedTransitCiphertext {
  name: string;
  version: number;
  value: EncryptedValue;
}

export function decodeTransitCiphertext(raw: string): DecodedTransitCiphertext {
  const parts = raw.split(".");
  if (parts.length !== 6 || parts[0] !== ENVELOPE_PREFIX) {
    throw new AppError(400, "invalid ciphertext envelope", "invalid_ciphertext");
  }
  const [, name, versionRaw, iv, tag, ciphertext] = parts;
  const version = Number(versionRaw);
  if (!NAME_PATTERN.test(name) || !Number.isInteger(version) || version < 1) {
    throw new AppError(400, "invalid ciphertext envelope", "invalid_ciphertext");
  }
  return { name, version, value: { ciphertext, iv, tag } };
}

async function keyMaterial(
  deps: Deps,
  project: ProjectRow,
  name: string,
  version: number,
): Promise<Buffer> {
  const row = await getTransitKey(deps, project.id, name, version);
  if (!row) throw new AppError(400, "unknown transit key", "unknown_transit_key");
  const material = decryptValue(
    projectDek(deps, project),
    { ciphertext: row.wrapped, iv: row.iv, tag: row.tag },
    keyAad(project.id, name, version),
  );
  return Buffer.from(material, "base64");
}

export async function encryptWithTransitKey(
  deps: Deps,
  project: ProjectRow,
  input: { name: string; plaintext: string; context?: string },
): Promise<{ ciphertext: string; keyVersion: number }> {
  const row = await ensureTransitKey(deps, project, input.name);
  const key = await keyMaterial(deps, project, row.name, row.version);
  const encrypted = encryptValue(
    key,
    input.plaintext,
    dataAad(project.id, row.name, row.version, input.context ?? ""),
  );
  return {
    ciphertext: encodeTransitCiphertext(row.name, row.version, encrypted),
    keyVersion: row.version,
  };
}

export async function decryptWithTransitKey(
  deps: Deps,
  project: ProjectRow,
  input: { ciphertext: string; context?: string },
): Promise<{ plaintext: string; key: string; keyVersion: number }> {
  const envelope = decodeTransitCiphertext(input.ciphertext);
  const key = await keyMaterial(deps, project, envelope.name, envelope.version);
  try {
    const plaintext = decryptValue(
      key,
      envelope.value,
      dataAad(project.id, envelope.name, envelope.version, input.context ?? ""),
    );
    return { plaintext, key: envelope.name, keyVersion: envelope.version };
  } catch {
    throw new AppError(400, "decryption failed", "decrypt_failed");
  }
}
