import { describe, expect, it } from "vitest";
import { ADMISSION_PROJECTION_GAP_MESSAGE, failedWriteMessage, refusalWordsOf } from "./hope-api";
import { sfvErrorFrom } from "./hope-sfv-errors";

// M10_ADMISSION_PROJECTION_GAP is refused by the SFV completion path with text that names an admission id and tells the
// caller to send the request again with a NEW Idempotency-Key. That is an integrator's instruction (the web client renews
// the key on its own), so a clinician is shown this module's own sentence, with the code kept for whoever they report it to.

/** The real 422 text of the code (hope-sfv-completion-guards.ts). */
const REAL_PROJECTION_GAP_TEXT =
  "Admission 00000000-0000-4000-8000-000000000001 could not be projected by the M6 status seam, so the SFV completion cannot be bound to it. Once the admission is repaired, send the request again with a NEW Idempotency-Key (the idempotency layer replays this 422 for 24 h on the same key).";

const reply = {
  data: undefined,
  error: { error: { code: "M10_ADMISSION_PROJECTION_GAP", message: REAL_PROJECTION_GAP_TEXT } },
  response: { ok: false, status: 422 },
};

describe("the words for M10_ADMISSION_PROJECTION_GAP", () => {
  it("are this module's sentence, with the code and no Idempotency-Key advice", () => {
    const words = refusalWordsOf(reply.error);

    expect(words).toBe(ADMISSION_PROJECTION_GAP_MESSAGE);
    expect(words).toContain("M10_ADMISSION_PROJECTION_GAP");
    expect(words).toContain("Contact your administrator");
    expect(words).not.toMatch(/idempotency/i);
    expect(words).not.toContain("00000000-0000-4000-8000-000000000001");
  });

  it("are the same wherever a failed write is worded", () => {
    expect(failedWriteMessage(reply, "unconfirmed", "fallback")).toBe(
      ADMISSION_PROJECTION_GAP_MESSAGE,
    );
  });

  it("are what the Complete SFV dialog shows for the 422 that the SFV completion path refuses with", () => {
    const shown = sfvErrorFrom(reply.error, 422);

    expect(shown.message).toBe(ADMISSION_PROJECTION_GAP_MESSAGE);
    expect(`${shown.title} ${shown.message}`).not.toMatch(/idempotency/i);
  });
});
