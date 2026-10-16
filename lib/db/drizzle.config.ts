import { defineConfig } from "drizzle-kit";
import path from "path";
import type { ConnectionOptions } from "tls";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

/**
 * Parse DATABASE_URL into host credentials so we can pass TLS settings that
 * match the runtime Pool. Do NOT append `sslmode=require` to the URL — recent
 * `pg` treats that as verify-full and rejects Railway's certificates during
 * `drizzle-kit push` ("Pulling schema from database…" then exit 1).
 */
function postgresCredentials(): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean | ConnectionOptions;
} {
  const raw = process.env.DATABASE_URL!;
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("DATABASE_URL must include a database name path");
  }

  const sslMode = (process.env.DATABASE_SSL ?? "").trim().toLowerCase();
  const forceOff = sslMode === "0" || sslMode === "false" || sslMode === "disable";
  const forceOn =
    sslMode === "1" ||
    sslMode === "true" ||
    sslMode === "require" ||
    sslMode === "prefer";
  const looksLocal = /^(localhost|127\.0\.0\.1)$/i.test(url.hostname);
  const looksManaged =
    /railway\.(app|internal)|rlwy\.net|neon\.tech|supabase\.(co|com)|amazonaws\.com|azure\.com|render\.com/i.test(
      url.hostname,
    ) || url.searchParams.has("sslmode");
  const useSsl = forceOn || (!forceOff && !looksLocal && looksManaged);

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    // drizzle-kit treats a missing `ssl` key as `ssl: {}`, which turns TLS on
    // and rejects Ubuntu's local self-signed Postgres cert. `false` keeps
    // localhost plaintext; managed hosts still use rejectUnauthorized: false.
    ssl: useSsl ? ({ rejectUnauthorized: false } satisfies ConnectionOptions) : false,
  };
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: postgresCredentials(),
});
