// The M7 write helpers are the ONE path the Care Plan view writes through: they must read the platform error
// envelope (`{ error: { code, message } }`), hand the raw body back for step-up / stale / field reading, and
// call a body-less 2xx a success.
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapCarePlan,
  createProblem,
  errorMessage,
  fieldErrorsOf,
  isKeyStuck,
  isStaleVersion,
  loadPatientAdmissions,
  resolveProblem,
} from "../care-plan-api";

const PLAN = "plan-1";
const answer = (status: number, body: { data?: unknown; error?: unknown }) => ({
  ...body,
  response: new Response(null, { status }),
});
const clientWith = (post: unknown, get?: unknown): ApiClient =>
  ({ POST: vi.fn(async () => post), GET: vi.fn(async () => get) }) as unknown as ApiClient;

describe("write helper results", () => {
  it("reads the refusal reason out of the platform envelope, not a top-level message", async () => {
    const envelope = { error: { code: "FORBIDDEN", message: "care_plan.bootstrap is required" } };
    const res = await bootstrapCarePlan(clientWith(answer(403, { error: envelope })), "p", "a");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.message).toBe("care_plan.bootstrap is required");
    expect(res.body).toBe(envelope);
  });

  it("calls a 2xx without a body a success (the write happened)", async () => {
    const res = await resolveProblem(
      clientWith(answer(200, { data: undefined })),
      PLAN,
      "e",
      3,
      "n",
    );
    expect(res.ok).toBe(true);
  });

  it("calls an error page with an empty body a failure, not a success", async () => {
    const res = await createProblem(clientWith(answer(502, { error: "" })), PLAN, {
      description: "d",
      kind: "related",
      source: "clinical",
    });
    expect(res.ok).toBe(false);
  });

  it("recognises the stale-write envelope", () => {
    expect(isStaleVersion({ error: { code: "STALE_VERSION" } })).toBe(true);
    expect(isStaleVersion({ error: { code: "CONFLICT" } })).toBe(false);
  });
});

describe("the two idempotency 409s read as plain words, not the server's jargon", () => {
  const SERVER_SENTENCE = "Idempotency-Key request is still being processed";
  const cases = [
    { code: "IDEMPOTENCY_IN_FLIGHT", plain: /still being saved/ },
    { code: "IDEMPOTENCY_KEY_STUCK", plain: /could not confirm/ },
  ];

  for (const { code, plain } of cases) {
    it(`${code}: the write result and the workspace message both avoid the server's sentence`, async () => {
      const envelope = { error: { code, message: SERVER_SENTENCE } };
      const res = await bootstrapCarePlan(clientWith(answer(409, { error: envelope })), "p", "a");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.status).toBe(409);
      expect(res.message).toMatch(plain);
      expect(res.message).not.toMatch(/idempotency/i);
      // The view reads refusals through errorMessage(body), so it must agree.
      expect(errorMessage(envelope, "fallback")).toBe(res.message);
    });
  }

  it("also reads the in-flight duplicate an older server answers as a plain CONFLICT", async () => {
    // Deploy window: before the server answers IDEMPOTENCY_IN_FLIGHT it sends this exact sentence under CONFLICT.
    const envelope = { error: { code: "CONFLICT", message: SERVER_SENTENCE } };
    const res = await bootstrapCarePlan(clientWith(answer(409, { error: envelope })), "p", "a");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/still being saved/);
    expect(res.message).not.toMatch(/idempotency/i);
  });

  it("keeps a CONFLICT that is about the plan, not the key", async () => {
    const envelope = { error: { code: "CONFLICT", message: "a plan already exists" } };
    const res = await bootstrapCarePlan(clientWith(answer(409, { error: envelope })), "p", "a");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe("a plan already exists");
  });

  it("recognises only the stuck-key refusal as stuck", () => {
    expect(isKeyStuck({ error: { code: "IDEMPOTENCY_KEY_STUCK" } })).toBe(true);
    expect(isKeyStuck({ error: { code: "IDEMPOTENCY_IN_FLIGHT" } })).toBe(false);
    expect(isKeyStuck({ error: { code: "STALE_VERSION" } })).toBe(false);
    expect(isKeyStuck(null)).toBe(false);
  });

  it("keeps the server's own reason for any other 409", async () => {
    const envelope = { error: { code: "OPEN_VERSION_EXISTS", message: "a draft is already open" } };
    const res = await bootstrapCarePlan(clientWith(answer(409, { error: envelope })), "p", "a");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe("a draft is already open");
    expect(errorMessage(envelope, "fallback")).toBe("a draft is already open");
  });
});

describe("loadPatientAdmissions", () => {
  it("returns a refused read as an error, never as 'no admissions'", async () => {
    const get = answer(500, { error: { error: { message: "down" } } });
    const res = await loadPatientAdmissions(clientWith(null, get), "p");
    expect(res.admissions).toEqual([]);
    expect(res.error).toEqual({ error: { message: "down" } });
  });

  it("returns the admissions when the read succeeds", async () => {
    const items = [{ id: "a", state: "active", admissionAt: null, dischargedAt: null }];
    const res = await loadPatientAdmissions(
      clientWith(null, answer(200, { data: { items } })),
      "p",
    );
    expect(res).toEqual({ admissions: items, error: null });
  });
});

describe("fieldErrorsOf", () => {
  it("maps envelope details to their exact property", () => {
    const errors = fieldErrorsOf({
      error: {
        message: "invalid",
        details: [
          { field: "description", code: "x", message: "Too short" },
          { field: "body/kind", code: "x", message: "Pick one" },
          { field: "(root)", code: "x", message: "ignored" },
        ],
      },
    });
    expect(errors).toEqual({ description: "Too short", kind: "Pick one" });
  });

  it("maps a Fastify body message to the one property it names and no other", () => {
    const errors = fieldErrorsOf({
      error: { message: "body/kind must be equal to one of the allowed values (see description)" },
    });
    expect(Object.keys(errors)).toEqual(["kind"]);
  });

  it("maps a missing required property", () => {
    expect(
      Object.keys(fieldErrorsOf({ message: "body must have required property 'scopeText'" })),
    ).toEqual(["scopeText"]);
  });

  it("maps a message that names no property to nothing", () => {
    expect(fieldErrorsOf({ error: { message: "The description is wrong" } })).toEqual({});
  });
});
