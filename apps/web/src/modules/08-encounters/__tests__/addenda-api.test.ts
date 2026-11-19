// The addendum access layer (ADR-0114 VN-D30): opening an amending addendum, and what a refused sign carries back. Synthetic data only.
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { openAddendum, signAddendum } from "../addenda-api";

const clientWith = (method: "POST", answer: unknown) => {
  const fn = vi.fn(async () => answer);
  return { client: { [method]: fn } as unknown as ApiClient, fn };
};

describe("openAddendum", () => {
  it("sends only the reason for a free addendum, exactly as before", async () => {
    const { client, fn } = clientWith("POST", { data: { id: "a", status: "draft" } });
    await openAddendum(client, "enc-1", "Family reported more pain.", []);
    expect(fn).toHaveBeenCalledWith("/api/v1/encounters/{encounterId}/addenda", {
      params: { path: { encounterId: "enc-1" } },
      body: { reason: "Family reported more pain." },
    });
  });

  it("names the sections to amend when there are some", async () => {
    const { client, fn } = clientWith("POST", { data: { id: "a", status: "draft" } });
    await openAddendum(client, "enc-1", "Correct the plan.", ["plan", "pain"]);
    expect(fn).toHaveBeenCalledWith("/api/v1/encounters/{encounterId}/addenda", {
      params: { path: { encounterId: "enc-1" } },
      body: { reason: "Correct the plan.", amendsSectionIds: ["plan", "pain"] },
    });
  });

  it("words a 404 and an unknown section for the person, keeping the status", async () => {
    const notFound = clientWith("POST", {
      error: { error: { code: "NOT_FOUND", message: "not found" } },
      response: { status: 404 },
    });
    const refused = await openAddendum(notFound.client, "enc-1", "Reason.", ["plan"]);
    expect(refused.response).toEqual({ status: 404 });
    expect(JSON.stringify(refused.error)).toMatch(/switched off/);

    const unknown = clientWith("POST", {
      error: { error: { code: "UNKNOWN_TEMPLATE_SECTION", message: "no" } },
      response: { status: 422 },
    });
    expect(
      JSON.stringify((await openAddendum(unknown.client, "enc-1", "R.", ["x"])).error),
    ).toMatch(/not part of the signed note/);
  });

  it("leaves a free addendum's 404 as the server sent it: nothing is being amended", async () => {
    const error = { error: { code: "NOT_FOUND", message: "no such encounter" } };
    const { client } = clientWith("POST", { error, response: { status: 404 } });
    expect((await openAddendum(client, "enc-1", "Reason.", [])).error).toBe(error);
  });

  it("leaves another refusal exactly as the server sent it", async () => {
    const error = { error: { code: "VALIDATION_ERROR", message: "reason too short" } };
    const { client } = clientWith("POST", { error, response: { status: 422 } });
    expect((await openAddendum(client, "enc-1", "x", [])).error).toBe(error);
  });
});

describe("signAddendum", () => {
  it("carries the refusal's details back, so a stale section can be named", async () => {
    const details = [{ field: "pain", code: "DRAFT_SECTION_UNRESOLVED", message: "m" }];
    const { client } = clientWith("POST", {
      error: { error: { code: "DRAFT_SECTION_STALE", message: "stale", details } },
      response: { status: 409 },
    });
    expect(await signAddendum(client, { encounterId: "e", addendumId: "a" })).toMatchObject({
      ok: false,
      status: 409,
      code: "DRAFT_SECTION_STALE",
      details,
    });
  });

  it("carries the amended sections and the cosignature request of a signed amendment", async () => {
    const value = {
      status: "signed",
      signedAt: "2026-10-02T10:00:00Z",
      amendedSectionIds: ["pain"],
      cosignatureRequestId: "req-1",
    };
    const { client } = clientWith("POST", { data: value });
    expect(await signAddendum(client, { encounterId: "e", addendumId: "a" })).toEqual({
      ok: true,
      value,
    });
  });
});
