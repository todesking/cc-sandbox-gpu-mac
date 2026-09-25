/** The launcher passes cc-gpu-run's original environment as base64 of NUL-separated NAME=VALUE entries. */
export function decodeEnv(encoded: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of Buffer.from(encoded, 'base64').toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}
