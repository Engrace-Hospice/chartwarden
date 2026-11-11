/**
 * The commit tracker lives in AsyncLocalStorage, opened in `onRequest`. Every other idempotency test uses `app.inject`, which
 * replays the body from the same async context. On a REAL socket the body arrives later, from the socket's own async resource,
 * and the body parser resumes the lifecycle from there: if the store did not survive, the claim hook would see no tracker and
 * the fail-closed rule would cache every 5xx forever (a retry would replay the failure instead of running again).
 *
 * This listens on an ephemeral port and sends a JSON body in two delayed chunks, so the parse really finishes in a later
 * socket callback. A handler that fails before any write must still be RELEASED (the retry runs), and must see its tracker.
 */
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { currentCommitTracker } from "@chartwarden/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  applyIdempotency,
  createInMemoryIdempotencyStore,
} from "../src/bootstrap/plugins/idempotency";

const ORG = "00000000-0000-4000-8000-000000000001";
const CHUNK_DELAY_MS = 40;

/** POSTs `{"a":1}` to `/write` over a real socket, the body split in two chunks sent CHUNK_DELAY_MS apart. */
function postInChunks(port: number, key: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/write",
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.write('{"a":');
    setTimeout(() => req.end("1}"), CHUNK_DELAY_MS);
  });
}

describe("the commit tracker survives a body that arrives in later socket chunks", () => {
  let app: FastifyInstance;
  let runs = 0;
  let sawTracker: boolean[] = [];
  let warnings: string[] = [];

  async function listen(): Promise<number> {
    runs = 0;
    sawTracker = [];
    warnings = [];
    app = Fastify({
      logger: { level: "warn", stream: { write: (line: string) => void warnings.push(line) } },
    });
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { context: unknown }).context = {
        organizationId: ORG,
        correlationId: "cid-test",
      };
    });
    applyErrorHandler(app);
    applyIdempotency(app, createInMemoryIdempotencyStore());
    app.post("/write", async (req, reply) => {
      runs += 1;
      sawTracker.push(currentCommitTracker() !== undefined);
      if (runs === 1) return reply.code(503).send({ error: { code: "DEGRADED" } });
      return reply.code(201).send({ saved: true, echoed: req.body });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    return (app.server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await app?.close();
  });

  it("a 5xx that followed no write is released: the same-key retry runs, and the handler sees its tracker", async () => {
    const port = await listen();
    const first = await postInChunks(port, "key-socket-1");
    expect(first.status).toBe(503);
    const retry = await postInChunks(port, "key-socket-1");
    expect(retry.status).toBe(201);
    expect(runs).toBe(2);
    expect(sawTracker).toEqual([true, true]);
    expect(warnings).toEqual([]); // the fail-closed rule never had to fire
  });
});
