import { badRequest } from "./errors.js";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_IMPORT_KEYS = 200;

export interface ImportEntry {
  key: string;
  value: string;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a .env document: comments, blank lines, `export KEY=`, quoted values.
 * Multiline quoted values are not supported. Later duplicates win.
 */
export function parseDotenv(text: string): ImportEntry[] {
  const entries = new Map<string, string>();
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  lines.forEach((rawLine, index) => {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const equals = line.indexOf("=");
    if (equals <= 0) throw badRequest(`line ${index + 1}: expected KEY=VALUE`);

    const key = line.slice(0, equals).trim();
    if (!KEY_PATTERN.test(key)) throw badRequest(`line ${index + 1}: invalid key '${key}'`);

    entries.set(key, unquote(line.slice(equals + 1).trim()));
  });

  return Array.from(entries, ([key, value]) => ({ key, value }));
}

/**
 * Parses a flat JSON object of key -> scalar values.
 */
export function parseJsonSecrets(text: string): ImportEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("contents is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("JSON import must be a flat object of key/value pairs");
  }

  const entries: ImportEntry[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_PATTERN.test(key)) throw badRequest(`invalid key '${key}'`);
    if (typeof value === "object" && value !== null) {
      throw badRequest(`key '${key}' must have a string, number, or boolean value`);
    }
    entries.push({ key, value: value === null ? "" : String(value) });
  }
  return entries;
}

export function parseImportContents(contents: string, format: "env" | "json"): ImportEntry[] {
  const entries = format === "json" ? parseJsonSecrets(contents) : parseDotenv(contents);
  if (entries.length === 0) throw badRequest("no secrets found in the imported content");
  if (entries.length > MAX_IMPORT_KEYS) {
    throw badRequest(`too many secrets (${entries.length}); the limit is ${MAX_IMPORT_KEYS}`);
  }
  return entries;
}
