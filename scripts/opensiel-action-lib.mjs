export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function isValidEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function escapeCommand(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function dotenvValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+,-]*$/.test(text)) return text;
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

export function renderDotenv(secrets) {
  return (
    Object.entries(secrets)
      .filter(([key]) => isValidEnvKey(key))
      .map(([key, value]) => `${key}=${dotenvValue(value)}`)
      .join("\n") + "\n"
  );
}

export function envFileBlock(key, value, nonce) {
  let delimiter = `OPENSIEL_EOF_${nonce}`;
  while (String(value).includes(delimiter)) delimiter += "_";
  return `${key}<<${delimiter}\n${value}\n${delimiter}`;
}
