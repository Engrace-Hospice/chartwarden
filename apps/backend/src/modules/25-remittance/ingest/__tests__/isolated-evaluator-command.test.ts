import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { M25WriteActor } from "../../routes/actor";
import {
  createEvaluatorCommandSigner,
  createHttpEvaluatorTransport,
} from "../isolated-evaluator-command";
import { createIsolatedEvaluatorHandler } from "../isolated-evaluator-server";

const ORG = "10000000-0000-4000-8000-000000000001";
const USER = "10000000-0000-4000-8000-000000000002";
const MEMBER = "10000000-0000-4000-8000-000000000003";
const ARTIFACT = "10000000-0000-4000-8000-000000000004";
const actor: M25WriteActor & { readonly sessionId: string } = {
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBER,
  sessionId: "synthetic-session",
  roles: ["billing_specialist"],
  providerEntityScope: [],
  stepUpRecent: false,
};

describe("isolated M25 evaluator command boundary", () => {
  it("authenticates a minimal command and invokes the server-owned workflow", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const evaluate = vi.fn(async () => ({ status: "held", reasonCode: "SUBMISSION_UNVERIFIED" }));
    const handler = createIsolatedEvaluatorHandler({
      workflow: { evaluate, addNote: vi.fn(), transition: vi.fn() } as never,
      authority: { resolve: async () => actor },
      publicKeys: new Map([["test-key", publicKey]]),
      now: () => 1_000,
    });
    const transport = createHttpEvaluatorTransport({
      url: "http://isolated",
      signer: createEvaluatorCommandSigner({ kid: "test-key", key: privateKey, now: () => 1_000 }),
      fetchImpl: (url, init) => handler(new Request(url, init)),
    });
    await expect(
      transport.execute(actor, {
        operation: "evaluate",
        artifactId: ARTIFACT,
        idempotencyKey: "same-key-123",
      }),
    ).resolves.toEqual({ status: "held", reasonCode: "SUBMISSION_UNVERIFIED" });
    expect(evaluate).toHaveBeenCalledWith(actor, ARTIFACT, "same-key-123");
  });

  it("answers a missing or out-of-scope review as 404 and logs the failure without ids", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const log = vi.fn();
    const notFound = Object.assign(new Error("Medicaid ERA review not found"), {
      name: "NotFoundError",
    });
    const handler = createIsolatedEvaluatorHandler({
      workflow: {
        evaluate: vi.fn(),
        addNote: vi.fn(async () => {
          throw notFound;
        }),
        transition: vi.fn(),
      } as never,
      authority: { resolve: async () => actor },
      publicKeys: new Map([["test-key", publicKey]]),
      now: () => 1_000,
      log,
    });
    const transport = createHttpEvaluatorTransport({
      url: "http://isolated",
      signer: createEvaluatorCommandSigner({ kid: "test-key", key: privateKey, now: () => 1_000 }),
      fetchImpl: (url, init) => handler(new Request(url, init)),
    });
    await expect(
      transport.execute(actor, {
        operation: "note",
        reviewId: ARTIFACT,
        expectedVersion: 1,
        reasonCode: "SYNTHETIC_REASON",
        idempotencyKey: "same-key-456",
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "m25.evaluator.command_failed",
      status: 404,
      errorName: "NotFoundError",
    });
    expect(line).not.toContain(ARTIFACT);
  });

  it("rejects payload modification and caller-supplied assessment properties", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = createEvaluatorCommandSigner({
      kid: "test-key",
      key: privateKey,
      now: () => 1_000,
    });
    const valid = {
      operation: "evaluate" as const,
      artifactId: ARTIFACT,
      idempotencyKey: "same-key-123",
    };
    const handler = createIsolatedEvaluatorHandler({
      workflow: {} as never,
      authority: { resolve: async () => actor },
      publicKeys: new Map([["test-key", publicKey]]),
      now: () => 1_000,
    });
    const response = await handler(
      new Request("http://isolated/internal/m25/commands", {
        method: "POST",
        headers: { "x-cw-m25-command": signer(actor, valid) },
        body: JSON.stringify({ ...valid, postingAuthorized: true }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a replayed signed command before a second mutation", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const command = {
      operation: "evaluate" as const,
      artifactId: ARTIFACT,
      idempotencyKey: "same-key-123",
    };
    const assertion = createEvaluatorCommandSigner({
      kid: "test-key",
      key: privateKey,
      now: () => 1_000,
    })(actor, command);
    const evaluate = vi.fn(async () => ({ status: "held", reasonCode: "SUBMISSION_UNVERIFIED" }));
    const handler = createIsolatedEvaluatorHandler({
      workflow: { evaluate } as never,
      authority: { resolve: async () => actor },
      publicKeys: new Map([["test-key", publicKey]]),
      now: () => 1_000,
    });
    const request = () =>
      new Request("http://isolated/internal/m25/commands", {
        method: "POST",
        headers: { "x-cw-m25-command": assertion },
        body: JSON.stringify(command),
      });
    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(409);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("bounds request bodies and reports unavailable database readiness", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const handler = createIsolatedEvaluatorHandler({
      workflow: {} as never,
      authority: { resolve: async () => actor },
      publicKeys: new Map([["test-key", publicKey]]),
      ready: async () => false,
    });
    expect((await handler(new Request("http://isolated/ready"))).status).toBe(503);
    const readyHandler = createIsolatedEvaluatorHandler({
      workflow: {} as never,
      authority: { resolve: async () => actor },
      publicKeys: new Map([["test-key", publicKey]]),
    });
    const oversized = JSON.stringify({
      operation: "evaluate",
      artifactId: ARTIFACT,
      idempotencyKey: "same-key-123",
      padding: "x".repeat(5000),
    });
    expect(
      (
        await readyHandler(
          new Request("http://isolated/internal/m25/commands", {
            method: "POST",
            headers: {
              "content-length": String(Buffer.byteLength(oversized)),
              "x-cw-m25-command": createEvaluatorCommandSigner({
                kid: "test-key",
                key: privateKey,
              })(actor, {
                operation: "evaluate",
                artifactId: ARTIFACT,
                idempotencyKey: "same-key-123",
              }),
            },
            body: oversized,
          }),
        )
      ).status,
    ).toBe(413);
  });

  it("caps concurrent evaluator commands", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    let unblock: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const handler = createIsolatedEvaluatorHandler({
      workflow: {
        evaluate: async () => {
          entered?.();
          await release;
          return { status: "held", reasonCode: "SUBMISSION_UNVERIFIED" };
        },
      } as never,
      authority: { resolve: async () => actor },
      publicKeys: new Map([["test-key", publicKey]]),
      maxInFlight: 1,
    });
    const command = {
      operation: "evaluate" as const,
      artifactId: ARTIFACT,
      idempotencyKey: "same-key-123",
    };
    const request = () =>
      new Request("http://isolated/internal/m25/commands", {
        method: "POST",
        headers: {
          "x-cw-m25-command": createEvaluatorCommandSigner({
            kid: "test-key",
            key: privateKey,
          })(actor, command),
        },
        body: JSON.stringify(command),
      });
    const first = handler(request());
    await enteredPromise;
    expect((await handler(request())).status).toBe(503);
    unblock?.();
    expect((await first).status).toBe(200);
  });
});
