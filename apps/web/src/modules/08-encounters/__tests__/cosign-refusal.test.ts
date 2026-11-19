// What the cosigner reads when a cosignature step (acknowledge, sign, supervisor release) is refused, by the server's code and status, for a
// note and for an amendment (ADR-0114 VN-D30, S1 PR E4). Each sentence is the app's own: what happened, whether anything changed, and the
// next step. Synthetic data only.
import { describe, expect, it } from "vitest";
import type { CosignStep } from "../cosign-model";
import { cosignRefusalMessage, isStepUpRefusal } from "../cosign-refusal";

const say = (
  over: Partial<Parameters<typeof cosignRefusalMessage>[0]> & { code?: string | undefined } = {},
) =>
  cosignRefusalMessage({
    status: 409,
    code: undefined,
    step: "sign",
    subject: "addendum",
    ...over,
  });

describe("409 ILLEGAL_TRANSITION", () => {
  it("says the request moved on, that nothing changed, and to reload", () => {
    const text = say({ code: "ILLEGAL_TRANSITION" });
    expect(text).toMatch(/already/i);
    expect(text).toMatch(/nothing was changed/i);
    expect(text).toMatch(/reload/i);
  });

  it("names the amendment, or the note", () => {
    expect(say({ code: "ILLEGAL_TRANSITION" })).toMatch(/amendment/);
    expect(say({ code: "ILLEGAL_TRANSITION", subject: "note" })).toMatch(/note/);
    expect(say({ code: "ILLEGAL_TRANSITION", subject: "note" })).not.toMatch(/amendment/);
  });
});

describe("409 COSIGNATURE_LOCKED", () => {
  it("says it is locked at the 48-hour cap and that a supervisor must release it first", () => {
    const text = say({ code: "COSIGNATURE_LOCKED" });
    expect(text).toMatch(/48-hour/);
    expect(text).toMatch(/supervisor/i);
    expect(text).toMatch(/release/i);
    expect(text).toMatch(/nothing was changed/i);
  });
});

describe("step-up", () => {
  it("says the sign needs a fresh re-authentication, and what to do", () => {
    const text = say({ status: 403, code: "STEP_UP_REQUIRED" });
    expect(text).toMatch(/re-authenticat/i);
    expect(text).toMatch(/nothing was changed/i);
  });

  it("reads the machine's expired step-up the same way", () => {
    expect(say({ status: 412, code: "STEP_UP_AUTH_REQUIRED" })).toMatch(/re-authenticat/i);
  });

  it("words a 403 FORBIDDEN that names step_up_recent as a re-authentication, not as a role refusal", () => {
    const text = say({ status: 403, code: "FORBIDDEN", message: "needs step_up_recent" });
    expect(text).toMatch(/re-authenticat/i);
    expect(text).not.toMatch(/only an RN/);
    expect(text).not.toMatch(/clinical supervisor/);
    expect(text).not.toMatch(/step_up_recent/);
    expect(
      say({ status: 403, code: "FORBIDDEN", message: "needs step_up_recent", step: "release" }),
    ).toMatch(/re-authenticat/i);
  });

  it("still words a 403 whose message does not name step-up as a role refusal", () => {
    expect(say({ status: 403, code: "FORBIDDEN", message: "no self-cosign" })).toMatch(
      /only an RN/,
    );
  });

  it("recognises every shape of it, and no other 403", () => {
    expect(isStepUpRefusal({ status: 403, code: "STEP_UP_REQUIRED", message: undefined })).toBe(
      true,
    );
    expect(
      isStepUpRefusal({ status: 412, code: "STEP_UP_AUTH_REQUIRED", message: undefined }),
    ).toBe(true);
    expect(
      isStepUpRefusal({ status: 403, code: "FORBIDDEN", message: "needs step_up_recent" }),
    ).toBe(true);
    expect(isStepUpRefusal({ status: 403, code: "FORBIDDEN", message: "no self-cosign" })).toBe(
      false,
    );
    expect(isStepUpRefusal({ status: 401, code: undefined, message: undefined })).toBe(false);
  });
});

describe("403", () => {
  it.each<[CosignStep, RegExp]>([
    ["acknowledge", /RN with cosign access who wrote neither/],
    ["sign", /RN with cosign access who wrote neither/],
    ["release", /supervisor|director of nursing/i],
  ])("says who can do the %s step", (step, who) => {
    const text = say({ status: 403, code: "FORBIDDEN", step });
    expect(text).toMatch(who);
    expect(text).toMatch(/nothing was changed/i);
  });

  it("names a supervisor release the server refused because the caller is not one", () => {
    const text = say({ status: 403, code: "SUPERVISOR_RELEASE_NOT_PERMITTED", step: "release" });
    expect(text).toMatch(/supervisor/i);
  });

  it("names a sign the server refused because the caller is not an RN", () => {
    expect(say({ status: 403, code: "NOT_COSIGN_ELIGIBLE" })).toMatch(/registered nurse|RN/);
  });
});

describe("404", () => {
  it("says it could not be found, that nothing was changed, and to reload", () => {
    const text = say({ status: 404, code: "NOT_FOUND" });
    expect(text).toMatch(/could not be found/i);
    expect(text).toMatch(/nothing was changed/i);
    expect(text).toMatch(/reload/i);
  });
});

describe("the rest", () => {
  it("asks for a longer reason when the release reason is too short", () => {
    const text = say({
      status: 422,
      code: "SUPERVISOR_RELEASE_REASON_TOO_SHORT",
      step: "release",
    });
    expect(text).toMatch(/40 characters/);
  });

  it("says a 409 it has no sentence for is a change made meanwhile, and to reload", () => {
    const text = say({ status: 409, code: "STALE_VERSION" });
    expect(text).toMatch(/changed/i);
    expect(text).toMatch(/reload/i);
  });

  it("says a failure it has no sentence for could not be completed, and to try again", () => {
    const text = say({ status: 500, code: undefined });
    expect(text).toMatch(/could not be completed/i);
    expect(text).toMatch(/try again/i);
  });

  it("never echoes the server's own text", () => {
    expect(say({ status: 500, code: "BOOM" })).not.toMatch(/BOOM/);
  });
});
