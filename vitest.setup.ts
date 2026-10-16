// Importing anything under `@/server/api/*` pulls in `lib/db/index.ts`, which
// throws at load if DATABASE_URL is missing. Tests never open that pool:
// they all use `createTestDb()` (pglite), so a dummy value is enough.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/vitest-not-used";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-chars-long";
