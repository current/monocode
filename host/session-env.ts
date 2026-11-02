/**
 * Per-session environment for provider children. Only an /operator lead's
 * running turn gets app-access variables; every other child (workers,
 * catalog probes, title generation) has them removed, even when the host
 * itself was started from a shell that had them.
 */
export const APP_ENV_KEYS = [
  "MONOCODE",
  "MONOCODE_APP_URL",
  "MONOCODE_APP_TOKEN",
] as const;

const sessions = new Map<string, Record<string, string>>();

export function setSessionEnv(id: string, env: Record<string, string>): void {
  sessions.set(id, env);
}

export function clearSessionEnv(id: string): void {
  sessions.delete(id);
}

export function childEnv(
  id: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MONOCODE_HOST: "1" };
  for (const key of APP_ENV_KEYS) delete env[key];
  return { ...env, ...sessions.get(id) };
}
