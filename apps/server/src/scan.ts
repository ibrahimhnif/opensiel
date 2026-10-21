import type { ScanFinding } from "@opensiel/shared";

export interface StoredSecretInput {
  environment: string;
  path: string;
  key: string;
  value: string;
}

interface Pattern {
  name: string;
  source: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "AWS access key", source: /AKIA[0-9A-Z]{16}/g },
  { name: "GitHub token", source: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "Slack token", source: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Stripe secret key", source: /sk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "Google API key", source: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "Private key", source: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  {
    name: "JSON web token",
    source: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
];

const MAX_FINDINGS = 100;
const MAX_STORED_SECRETS = 2000;
const MIN_STORED_MATCH = 8;

function lineAt(contents: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (contents.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

export function maskValue(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export function scanText(contents: string, stored: StoredSecretInput[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();

  const push = (finding: ScanFinding) => {
    if (findings.length >= MAX_FINDINGS) return;
    const id = `${finding.type}:${finding.environment ?? ""}:${finding.name}:${finding.line}`;
    if (seen.has(id)) return;
    seen.add(id);
    findings.push(finding);
  };

  for (const secret of stored.slice(0, MAX_STORED_SECRETS)) {
    if (secret.value.length < MIN_STORED_MATCH) continue;
    let index = contents.indexOf(secret.value);
    while (index !== -1 && findings.length < MAX_FINDINGS) {
      push({
        type: "stored-secret",
        name: secret.key,
        environment: secret.environment,
        path: secret.path,
        line: lineAt(contents, index),
        preview: maskValue(secret.value),
      });
      index = contents.indexOf(secret.value, index + secret.value.length);
    }
  }

  for (const candidate of PATTERNS) {
    const pattern = new RegExp(candidate.source.source, candidate.source.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(contents)) !== null && findings.length < MAX_FINDINGS) {
      push({
        type: "pattern",
        name: candidate.name,
        line: lineAt(contents, match.index),
        preview: maskValue(match[0]),
      });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  return findings.sort((a, b) => a.line - b.line).slice(0, MAX_FINDINGS);
}
