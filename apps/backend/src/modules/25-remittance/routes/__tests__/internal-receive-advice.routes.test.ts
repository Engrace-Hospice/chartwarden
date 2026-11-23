// POST /api/v1/internal/remittance/advices (route #32): the request field keeps its published name `minioObjectKey`
// (OpenAPI and the typed client carry it), while the service input and the `remittance_advice` column are `objectKey`
// / `object_key` after migration 1546. This pins the boundary mapping in internal.routes.ts.
import {
  resetEffectivePermissionResolver,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import { FormatRegistry } from "@sinclair/typebox";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { M25IngestService, ReceiveAdviceInput } from "../../ingest/service";
import { registerInternalRoutes } from "../internal.routes";

// m25-typebox.ts relies on another module having registered the uuid checker (see remittance-inject.test.ts).
if (!FormatRegistry.Has("uuid"))
  FormatRegistry.Set("uuid", (v) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  );

const ORG = "10000000-0000-4000-8000-000000000001";
const PROVIDER = "20000000-0000-4000-8000-000000000001";
const PAYER = "30000000-0000-4000-8000-000000000001";
const ADVICE = "40000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);
const WIRE_BODY = {
  providerEntityId: PROVIDER,
  payerId: PAYER,
  payerKind: "medicare",
  minioObjectKey: "clearinghouse/synthetic/rem-1",
  fileSha256: SHA,
  rawEdi: "ISA*synthetic~",
} as const;

function setup() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.context = {
      correlationId: "synthetic-correlation",
      userId: "synthetic-system",
      organizationId: ORG,
      providerEntityIds: [],
      locationIds: [],
      roles: [],
      attributes: { actorKind: "system" },
      ip: "127.0.0.1",
      userAgent: "test",
      startTime: Date.now(),
    };
  });
  setEffectivePermissionResolver(() => new Set(["remittance.ingest_internal"]));
  const receiveAdvice = vi.fn(async (_actor: unknown, _input: ReceiveAdviceInput) => ({
    outcome: "queued" as const,
    adviceId: ADVICE,
  }));
  registerInternalRoutes(app, {
    readService: {} as never,
    ingestService: { receiveAdvice } as unknown as M25IngestService,
  });
  return { app, receiveAdvice };
}

afterEach(() => resetEffectivePermissionResolver());

describe("POST /api/v1/internal/remittance/advices", () => {
  it("accepts the published request field minioObjectKey and hands the service objectKey", async () => {
    // Arrange
    const { app, receiveAdvice } = setup();

    // Act
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/remittance/advices",
      payload: WIRE_BODY,
    });

    // Assert
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ outcome: "queued", adviceId: ADVICE });
    expect(receiveAdvice).toHaveBeenCalledTimes(1);
    const [actor, input] = receiveAdvice.mock.calls[0]!;
    expect(actor).toEqual({ organizationId: ORG });
    expect(input).toEqual({
      providerEntityId: PROVIDER,
      payerId: PAYER,
      payerKind: "medicare",
      objectKey: "clearinghouse/synthetic/rem-1",
      fileSha256: SHA,
      rawEdi: "ISA*synthetic~",
    });
    expect(input).not.toHaveProperty("minioObjectKey");
  });

  it("refuses a body that carries only the new name: the published field did not change", async () => {
    // Arrange
    const { app, receiveAdvice } = setup();
    const { minioObjectKey: _published, ...rest } = WIRE_BODY;

    // Act
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/internal/remittance/advices",
      payload: { ...rest, objectKey: "clearinghouse/synthetic/rem-1" },
    });

    // Assert
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(receiveAdvice).not.toHaveBeenCalled();
  });
});
