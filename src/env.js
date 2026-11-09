// @ts-check

/**
 * Parse a dotenv file. `${VAR}` / `$VAR` expand against earlier keys in the file,
 * then `baseEnv`. Single-quoted values are literal. References that resolve to
 * nothing are reported so config validation can name the missing variable.
 *
 * @param {string} content
 * @param {Record<string, string | undefined>} baseEnv
 * @returns {{ vars: Record<string, string>, unresolved: Record<string, string[]> }}
 */
export function parseEnvFile(content, baseEnv = {}) {
  /** @type {Record<string, string>} */
  const vars = {};
  /** @type {Record<string, string[]>} */
  const unresolved = {};

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();

    const quote = val[0];
    if ((quote === '"' || quote === "'") && val.length >= 2 && val.endsWith(quote)) {
      val = val.slice(1, -1);
      if (quote === "'") {
        vars[key] = val;
        continue;
      }
    } else {
      // Unquoted: strip trailing " # comment"
      const hash = val.search(/\s#/);
      if (hash !== -1) val = val.slice(0, hash).trimEnd();
    }

    const missing = [];
    val = val.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
      const name = braced || bare;
      const resolved = vars[name] ?? baseEnv[name];
      if (!resolved) missing.push(name);
      return resolved ?? "";
    });
    if (missing.length) unresolved[key] = missing;
    vars[key] = val;
  }

  return { vars, unresolved };
}
