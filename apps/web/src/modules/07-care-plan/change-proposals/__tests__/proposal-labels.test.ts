// Every refusal the proposal routes can give has one sentence a clinician can act on, and the server's own wording never leaks through.
import { describe, expect, it } from "vitest";
import {
  DISMISSAL_REASON_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  proposalErrorMessage,
} from "../proposal-labels";

const envelope = (code: string) => ({ error: { code, message: `raw server text for ${code}` } });

describe("proposalErrorMessage", () => {
  it.each([
    ["VERSION_IN_REVIEW", 409, /waiting for signatures/i],
    ["DISCIPLINE_SCOPE_VIOLATION", 403, /outside your discipline/i],
    ["PROPOSAL_TARGET_UNAVAILABLE", 409, /removed or is already finished/i],
    ["PROPOSAL_PARENT_NOT_ACCEPTED", 409, /accept the problem first/i],
    ["PROPOSAL_PARENT_DISMISSED", 409, /problem .* was dismissed/i],
    ["CARE_PLAN_CLOSED", 409, /care plan is closed/i],
    ["PROPOSAL_NOT_PENDING", 409, /already decided/i],
    ["PROPOSAL_NOT_DRAFT", 409, /already gone to review/i],
    ["PROPOSAL_HAS_DEPENDENTS", 409, /withdraw them first/i],
    ["TOO_MANY_PROPOSALS", 409, /most proposed changes allowed \(50\)/i],
  ])("words %s for the person who met it", (code, status, words) => {
    const message = proposalErrorMessage(envelope(code), status);
    expect(message).toMatch(words);
    expect(message).not.toContain("raw server text");
  });

  it("answers a 404 without saying whether the proposal exists or is restricted", () => {
    expect(proposalErrorMessage(envelope("NOT_FOUND"), 404)).toMatch(/not available/i);
  });

  it("says a request that got no answer could not reach the server", () => {
    expect(proposalErrorMessage(undefined, null)).toMatch(/could not reach the server/i);
  });

  it("reuses the kit's words for the idempotency refusals", () => {
    expect(proposalErrorMessage(envelope("IDEMPOTENCY_IN_FLIGHT"), 409)).toMatch(
      /still being saved/i,
    );
    expect(proposalErrorMessage(envelope("IDEMPOTENCY_KEY_STUCK"), 409)).toMatch(
      /could not confirm whether that change was saved/i,
    );
  });
});

describe("the plain-language tables", () => {
  it("name every kind, status and dismissal reason without a raw code", () => {
    for (const label of [
      ...Object.values(KIND_LABEL),
      ...Object.values(STATUS_LABEL),
      ...Object.values(DISMISSAL_REASON_LABEL),
    ]) {
      expect(label).not.toMatch(/_/);
    }
    expect(Object.keys(KIND_LABEL)).toHaveLength(6);
  });
});
