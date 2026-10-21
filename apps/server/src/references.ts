export interface ReferencableSecret {
  path: string;
  key: string;
  value: string;
}

interface ParsedReference {
  path: string;
  key: string;
}

const REFERENCE = /(?<!\\)\$\{([^}]+)\}/g;
const ESCAPED = /\\(\$\{[^}]+\})/g;

class ReferenceCycleError extends Error {}

function parseReference(raw: string): ParsedReference | null {
  const reference = raw.trim();
  if (!reference) return null;

  if (reference.startsWith("/")) {
    const slash = reference.lastIndexOf("/");
    if (slash <= 0) return null;
    return { path: reference.slice(0, slash), key: reference.slice(slash + 1) };
  }

  return { path: "/", key: reference };
}

function idOf(path: string, key: string): string {
  return `${path}:${key}`;
}

/**
 * Resolves `${KEY}` and `${/path/KEY}` references against the given secret set.
 * `\${KEY}` is treated as a literal. Missing references and cycles are left as-is.
 */
export function resolveReferences(secrets: ReferencableSecret[]): Map<string, string> {
  const raw = new Map<string, string>();
  for (const secret of secrets) raw.set(idOf(secret.path, secret.key), secret.value);

  const cache = new Map<string, string>();

  const resolveValue = (value: string, stack: string[]): string => {
    const escaped: string[] = [];
    const protectedValue = value.replace(ESCAPED, (_match, reference: string) => {
      const index = escaped.push(reference) - 1;
      return `\u0000${index}\u0000`;
    });

    const resolved = protectedValue.replace(REFERENCE, (match, rawReference: string) => {
      const reference = parseReference(rawReference);
      if (!reference) return match;

      const id = idOf(reference.path, reference.key);
      if (stack.includes(id)) throw new ReferenceCycleError();

      const referenced = raw.get(id);
      if (referenced === undefined) return match;

      return resolveValue(referenced, [...stack, id]);
    });

    return resolved.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => escaped[Number(index)] ?? "");
  };

  for (const [id, value] of raw) {
    try {
      cache.set(id, resolveValue(value, [id]));
    } catch (error) {
      if (error instanceof ReferenceCycleError) {
        cache.set(id, value);
      } else {
        throw error;
      }
    }
  }
  return cache;
}
