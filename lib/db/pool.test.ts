import net from "node:net";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Just enough of the Postgres wire protocol to accept a connection: reply to
// the startup message with AuthenticationOk and ReadyForQuery.
const sockets: net.Socket[] = [];
const server = net.createServer((socket) => {
  sockets.push(socket);
  socket.once("data", () => {
    const ok = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
    const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
    socket.write(Buffer.concat([ok, ready]));
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  vi.stubEnv("DATABASE_URL", `postgresql://u:p@127.0.0.1:${port}/db`);
});

afterAll(() => {
  vi.unstubAllEnvs();
  server.close();
});

it("survives the database closing an idle connection, and connects again", async () => {
  const { pool } = await import("./index");
  const client = await pool.connect();
  client.release();
  expect(pool.idleCount).toBe(1);

  // What Neon does to idle connections when its compute suspends.
  sockets.shift()!.destroy();
  await vi.waitFor(() => expect(pool.idleCount).toBe(0));

  const again = await pool.connect();
  again.release();
  await pool.end();
});
