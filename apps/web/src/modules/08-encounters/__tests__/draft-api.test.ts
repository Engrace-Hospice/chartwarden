// The typed access layer of the visit-note draft screens (ADR-0114): what a link removal reports. Synthetic data only.
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it } from "vitest";
import { unlinkCarePlanElement } from "../draft-api";

const clientAnswering = (answer: { error?: unknown; response: { ok: boolean; status: number } }) =>
  ({ DELETE: async () => answer }) as unknown as ApiClient;

describe("unlinkCarePlanElement", () => {
  it("reports success for an answer with no body (204)", async () => {
    const outcome = await unlinkCarePlanElement(
      clientAnswering({ response: { ok: true, status: 204 } }),
      "enc-1",
      "link-1",
    );
    expect(outcome).toEqual({ ok: true, data: true });
  });

  it("does not report success for a refusal whose body is empty (the client hands back an empty string)", async () => {
    const outcome = await unlinkCarePlanElement(
      clientAnswering({ error: "", response: { ok: false, status: 500 } }),
      "enc-1",
      "link-1",
    );
    expect(outcome).toMatchObject({ ok: false, status: 500 });
  });

  it("reports the refusal's status and body when the server explains", async () => {
    const error = { error: { code: "ENCOUNTER_NOT_EDITABLE" } };
    const outcome = await unlinkCarePlanElement(
      clientAnswering({ error, response: { ok: false, status: 409 } }),
      "enc-1",
      "link-1",
    );
    expect(outcome).toEqual({ ok: false, status: 409, error });
  });

  it("reports no answer when the request throws", async () => {
    const client = {
      DELETE: async () => {
        throw new Error("offline");
      },
    } as unknown as ApiClient;
    expect(await unlinkCarePlanElement(client, "enc-1", "link-1")).toMatchObject({
      ok: false,
      status: 0,
    });
  });
});
