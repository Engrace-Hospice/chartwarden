import { describe, expect, it } from "vitest";
import {
  issueCodesClearedByEvaluation,
  noticeDeadlineIssueObservation,
  noticeIssueDeepLink,
  noticeIssueNotificationMessage,
  shouldReopenResolvedOccurrence,
} from "./medicare-notice-operational-issues";

describe("Medicare notice operational issue observations", () => {
  it("deduplicates stable deadline evidence and escalates by CMS-day stage", () => {
    const input = {
      noticeType: "noe" as const,
      noticeId: "a8f683c1-6d9b-46c7-83ee-53a9e8c89b6c",
      sourceVersion: 4,
    };
    expect(noticeDeadlineIssueObservation({ ...input, daysToDeadline: 2 })).toEqual(
      noticeDeadlineIssueObservation({ ...input, daysToDeadline: 2 }),
    );
    expect(noticeDeadlineIssueObservation({ ...input, daysToDeadline: 2 })).toMatchObject({
      issueCode: "noe_deadline_follow_up",
      occurrenceKey: "4:approaching",
      severity: "warning",
    });
    expect(noticeDeadlineIssueObservation({ ...input, daysToDeadline: 0 })).toMatchObject({
      occurrenceKey: "4:due_today",
      severity: "critical",
    });
    expect(noticeDeadlineIssueObservation({ ...input, daysToDeadline: -1 })).toMatchObject({
      occurrenceKey: "4:overdue",
      severity: "critical",
    });
  });

  it("does not invent deadline issues outside the policy watch window", () => {
    expect(
      noticeDeadlineIssueObservation({
        noticeType: "notr",
        noticeId: "a8f683c1-6d9b-46c7-83ee-53a9e8c89b6c",
        sourceVersion: 2,
        daysToDeadline: 3,
      }),
    ).toBeNull();
  });

  it("resolves only evaluated conditions absent from authoritative observations", () => {
    expect(
      issueCodesClearedByEvaluation(
        ["noe_deadline_follow_up", "submission_in_doubt", "submission_in_doubt"],
        [{ issueCode: "submission_in_doubt" }],
      ),
    ).toEqual(["noe_deadline_follow_up"]);
  });

  it("does not reopen a resolved occurrence from stale projection evidence", () => {
    expect(shouldReopenResolvedOccurrence("evidence-v1", "evidence-v1")).toBe(false);
    expect(shouldReopenResolvedOccurrence("evidence-v1", "evidence-v2")).toBe(true);
  });

  it("creates PHI-free links for each supported operational destination", () => {
    const noticeId = "a8f683c1-6d9b-46c7-83ee-53a9e8c89b6c";
    expect(noticeIssueDeepLink({ noticeType: "noe", noticeId, issueCode: "source" })).toBe(
      `/billing/noe/${noticeId}`,
    );
    expect(
      noticeIssueDeepLink({
        noticeType: "noe",
        noticeId,
        issueCode: "exception_review_follow_up",
      }),
    ).toBe(`/billing/noe/${noticeId}/exception-review`);
    expect(
      noticeIssueDeepLink({ noticeType: "cancellation", noticeId, issueCode: "transport" }),
    ).toBe(`/billing/transfer-notices?notice=${noticeId}&kind=cancellation`);
    expect(
      noticeIssueDeepLink({
        noticeType: "notr",
        noticeId,
        issueCode: "deadline",
        ddeWorkItemId: "dde-id",
      }),
    ).toBe("/billing/dde");
    expect(noticeIssueNotificationMessage("resolved", "info")).not.toContain(noticeId);
  });
});
