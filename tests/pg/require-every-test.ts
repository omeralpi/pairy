// With REQUIRE_PG=1 (the pg-concurrency job) every postgres test must run.
// vitest counts an it.skip, it.todo or describe.skip as "skipped" and still
// exits 0, so without this the job could go green with the race unproven.
// Only the REQUIRE_PG guards themselves, which stay skipped while PG_TEST_URL
// is set, may skip. As a setup file of vitest.pg.config.ts, this adds the test
// below to every postgres file, so even a file whose own tests are all skipped
// still runs it.

import { expect, it, type RunnerTask } from "vitest";

const GUARD = "has a PG_TEST_URL to run against";
const tests = (t: RunnerTask): RunnerTask[] => (t.type === "suite" ? t.tasks.flatMap(tests) : [t]);

if (process.env.REQUIRE_PG === "1" && process.env.PG_TEST_URL) {
  it("runs every postgres test in this file (REQUIRE_PG=1)", ({ task }) => {
    const notRun = task.file.tasks.flatMap(tests).filter((t) => t.mode !== "run" && t.name !== GUARD);
    expect(notRun.map((t) => t.name), "REQUIRE_PG=1, but these postgres tests did not run").toEqual([]);
  });
}
