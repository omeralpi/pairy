import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon requires TLS and uses a public CA, so verify its certificate; the
  // local docker Postgres does not speak TLS.
  ssl: isLocal ? false : true,
});

// Neon closes idle connections (compute suspend, pooler restart). The pool then
// emits "error" for that idle client, and with no listener that error crashes
// the process. The pool has already dropped the client; the next query
// connects again.
pool.on("error", (err) => console.error("Postgres closed an idle connection:", err.message));

export const db = drizzle({ client: pool, schema });

export type Db = typeof db;
