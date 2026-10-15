import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not set");
}

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon requires TLS; the local docker Postgres does not speak it.
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export const db = drizzle({ client: pool, schema });

export type Db = typeof db;
