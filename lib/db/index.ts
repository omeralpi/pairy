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

export const db = drizzle({ client: pool, schema });

export type Db = typeof db;
