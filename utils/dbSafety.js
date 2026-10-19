/*
  Scripts read the same DB_* variables as the server, and backend/.env holds
  the production credentials. One missing .env.local and a "local" script runs
  against production. These guards make the target explicit before anything is
  written.
*/

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLocalDatabaseHost(host) {
  return LOCAL_HOSTS.has(String(host || "").trim().toLowerCase());
}

export function describeDatabaseTarget(env = process.env) {
  return `${env.DB_NAME || "?"}@${env.DB_HOST || "?"}`;
}

// For scripts meant for a local or scratch database only.
export function assertLocalDatabase(scriptName, { argv = process.argv, env = process.env } = {}) {
  if (isLocalDatabaseHost(env.DB_HOST)) return;
  if (argv.includes("--allow-remote")) return;
  throw new Error(
    `${scriptName} kjører bare mot en lokal database. Målet er nå ${describeDatabaseTarget(env)}. ` +
    "Sett DB_HOST=127.0.0.1 i backend/.env.local, eller legg til --allow-remote hvis dette er en egen testdatabase."
  );
}

// For destructive scripts: the operator must name the exact target database.
export function assertConfirmedTarget(scriptName, { argv = process.argv, env = process.env } = {}) {
  const target = describeDatabaseTarget(env);
  const confirmed = argv
    .find((arg) => arg.startsWith("--confirm="))
    ?.slice("--confirm=".length);
  if (confirmed === target) return;
  throw new Error(
    `${scriptName} sletter data i ${target}. Kjør på nytt med --confirm=${target} hvis det er riktig database.`
  );
}
