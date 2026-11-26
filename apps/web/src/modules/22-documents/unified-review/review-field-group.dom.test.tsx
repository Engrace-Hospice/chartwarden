import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Candidate, Workspace } from "../doclens-api";
import { ReviewFieldGroup } from "./review-field-group";
import { type ReviewFieldGroupProjection, projectReviewGroups } from "./review-projection";

type Decision = NonNullable<Candidate["decision"]>;

const PAGES = 8;

function decision(kind: Decision["decision"], editedValue: string | null = null): Decision {
  return {
    id: `decision-${kind}-${editedValue ?? "none"}`,
    decision: kind,
    editedValue,
    reason: null,
    partOfBulkApprove: false,
    decidedAt: "2026-11-22T11:00:00.000Z",
  };
}

function candidate(
  index: number,
  fieldPath: string,
  value: string | null,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    jobId: "job-1",
    documentType: "discharge_summary",
    fieldPath,
    description: fieldPath,
    riskLevel: "low",
    confidence: 0.9,
    value,
    page: index,
    bbox: [10, 10 + index, 20, 20 + index],
    vision: { status: "not_required", observedValue: null },
    sudDetected: false,
    codingFlags: [],
    writebackTarget: true,
    redacted: false,
    decision: null,
    ...overrides,
  };
}

function workspaceWith(candidates: readonly Candidate[]): Workspace {
  return {
    batch: {
      id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      status: "in_review",
      sourceChannel: "fax",
      uploadedAt: "2026-11-22T10:00:00.000Z",
      documentId: "document-1",
      patientId: "patient-1",
      patientName: "Synthetic Patient",
      referralId: null,
      identityStatus: "match",
      recordsRequestConflict: null,
    },
    sud: {
      status: "not_detected",
      detectorRef: null,
      resolvedAt: null,
      resolvedByMembershipId: null,
      contentRedacted: false,
      indicators: [],
    },
    pages: [],
    documents: Array.from({ length: PAGES }, (_, offset) => ({
      pageFrom: offset + 1,
      pageTo: offset + 1,
      documentType: "discharge_summary" as const,
      title: `Synthetic document ${offset + 1}`,
      date: null,
      duplicateOfPage: null,
      boundary: null,
      identity: { status: "match" as const, disagreeing: [], resolution: null },
    })),
    jobs: [],
    review: { id: "review-1", status: "in_progress", reviewerMembershipId: "m-1", isMine: true },
    candidates: [...candidates],
  } as Workspace;
}

function groupFor(
  candidates: readonly Candidate[],
  canonicalFieldPath: string,
): ReviewFieldGroupProjection {
  const group = projectReviewGroups(workspaceWith(candidates)).find(
    (item) => item.canonicalFieldPath === canonicalFieldPath,
  );
  if (!group) throw new Error(`Expected a group for ${canonicalFieldPath}`);
  return group;
}

function mount(group: ReviewFieldGroupProjection) {
  const onSelectSource = vi.fn();
  const onReviewDecision = vi.fn();
  render(
    <ReviewFieldGroup
      group={group}
      onSelectSource={onSelectSource}
      onReviewDecision={onReviewDecision}
    />,
  );
  return { onSelectSource, onReviewDecision };
}

const CITY = "patient.address.city";
const STREET = "patient.address.line1";

function sixSalems(): Candidate[] {
  return [
    candidate(1, CITY, "Salem", { decision: decision("approve") }),
    candidate(2, CITY, "  salem ", { decision: decision("approve") }),
    candidate(3, CITY, "SALEM", { decision: decision("approve") }),
    candidate(4, CITY, "Salem"),
    candidate(5, CITY, "Salem  "),
    candidate(6, CITY, "salem"),
  ];
}

describe("ReviewFieldGroup consolidation", () => {
  it("shows identical values once with a source count, a decided summary and a collapsed disclosure", () => {
    mount(groupFor(sixSalems(), CITY));

    expect(screen.getByText(/6 source observations · 3 decided/)).toBeTruthy();
    expect(screen.getByText(/6 sources/)).toBeTruthy();
    expect(screen.getByText(/3 of 6 decided/)).toBeTruthy();
    expect(screen.getAllByText("Salem")).toHaveLength(1);
    const disclosure = screen.getByRole("button", { name: /Show sources/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Preview source/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Review decision/ })).toBeNull();
  });

  it("reveals every per-source row, each with its own actions, and collapses again", () => {
    const candidates = sixSalems();
    const { onSelectSource, onReviewDecision } = mount(groupFor(candidates, CITY));

    const disclosure = screen.getByRole("button", { name: /Show sources/ });
    fireEvent.click(disclosure);

    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("button", { name: /Preview source/ })).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: /Review decision/ })).toHaveLength(6);
    expect(screen.getByText(/Synthetic document 3 · Page 3 · 90% confidence/)).toBeTruthy();
    expect(screen.getAllByText("Approved")).toHaveLength(3);
    expect(screen.getAllByText("No decision recorded")).toHaveLength(3);

    const thirdRow = document.querySelector<HTMLElement>(
      `[data-candidate-id="${candidates[2]?.id}"]`,
    );
    if (!thirdRow) throw new Error("Expected the third source row");
    fireEvent.click(within(thirdRow).getByRole("button", { name: /Preview source/ }));
    expect(onSelectSource).toHaveBeenCalledTimes(1);
    expect(onSelectSource).toHaveBeenCalledWith(candidates[2]?.id);
    fireEvent.click(within(thirdRow).getByRole("button", { name: /Review decision/ }));
    expect(onReviewDecision).toHaveBeenCalledTimes(1);
    expect(onReviewDecision).toHaveBeenCalledWith(candidates[2]?.id);

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Preview source/ })).toBeNull();
  });

  it("offers no group-level decision control", () => {
    mount(groupFor(sixSalems(), CITY));
    fireEvent.click(screen.getByRole("button", { name: /Show sources/ }));

    expect(screen.queryByRole("button", { name: /accept|reject|approve|edit/i })).toBeNull();
  });

  it("keeps distinct values side by side under the conflict badge", () => {
    const street = [
      candidate(1, STREET, "1220 Alder St"),
      candidate(2, STREET, "1220 Alder St"),
      candidate(3, STREET, "1400 Harbor Blvd"),
      candidate(4, STREET, "1400 Harbor Blvd"),
      candidate(5, STREET, "1400 Harbor Blwvd"),
      candidate(6, STREET, "1400 Harbor Blwvd"),
    ];
    mount(groupFor(street, STREET));

    expect(screen.getByText("3 conflicting values")).toBeTruthy();
    expect(screen.getByText("1220 Alder St")).toBeTruthy();
    expect(screen.getByText("1400 Harbor Blvd")).toBeTruthy();
    expect(screen.getByText("1400 Harbor Blwvd")).toBeTruthy();
    expect(screen.getAllByText(/2 sources/)).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /Show sources/ })).toHaveLength(3);
  });

  it("expands one value without expanding another", () => {
    const street = [
      candidate(1, STREET, "1220 Alder St"),
      candidate(2, STREET, "1220 Alder St"),
      candidate(3, STREET, "1400 Harbor Blvd"),
      candidate(4, STREET, "1400 Harbor Blvd"),
    ];
    mount(groupFor(street, STREET));

    fireEvent.click(screen.getAllByRole("button", { name: /Show sources/ })[0] as HTMLElement);

    expect(screen.getAllByRole("button", { name: /Preview source/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Show sources/ })).toHaveLength(1);
  });

  it("does not merge an approved correction with an identical extracted value", () => {
    const corrected = candidate(1, CITY, "Salem", {
      decision: decision("approve_with_edit", "Keizer"),
    });
    const extracted = [candidate(2, CITY, "Keizer"), candidate(3, CITY, "keizer ")];
    mount(groupFor([corrected, ...extracted], CITY));

    expect(screen.getByText("Approved correction")).toBeTruthy();
    expect(screen.getByText("Extracted: Salem")).toBeTruthy();
    const correctedRow = document.querySelector<HTMLElement>(
      `[data-candidate-id="${corrected.id}"]`,
    );
    if (!correctedRow) throw new Error("Expected the correction to stay on its own visible row");
    expect(within(correctedRow).getByText("Keizer")).toBeTruthy();
    expect(within(correctedRow).getByRole("button", { name: /Review decision/ })).toBeTruthy();
    expect(screen.getByText(/2 sources/)).toBeTruthy();
  });

  it("keeps a rejected observation out of a consolidated row of identical values", () => {
    const rejected = candidate(1, CITY, "Salem", { decision: decision("reject") });
    const open = [candidate(2, CITY, "Salem"), candidate(3, CITY, "Salem")];
    mount(groupFor([rejected, ...open], CITY));

    const rejectedRow = document.querySelector<HTMLElement>(`[data-candidate-id="${rejected.id}"]`);
    if (!rejectedRow) throw new Error("Expected the rejected observation on its own visible row");
    expect(within(rejectedRow).getByText("Rejected")).toBeTruthy();
    expect(screen.getByText(/2 sources/)).toBeTruthy();
  });

  it("never merges withheld Part 2 observations", () => {
    const withheld = [
      candidate(1, CITY, null, { redacted: true }),
      candidate(2, CITY, null, { redacted: true }),
    ];
    mount(groupFor(withheld, CITY));

    expect(screen.getAllByText("Part 2 content withheld")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Show sources/ })).toBeNull();
  });

  it("flags a vision disagreement that sits inside a consolidated row", () => {
    const disagreed = candidate(2, CITY, "Salem", {
      vision: { status: "disagreed", observedValue: "Keizer" },
    });
    mount(groupFor([candidate(1, CITY, "Salem"), disagreed], CITY));

    expect(screen.getByText(/Vision disagreement/)).toBeTruthy();
  });

  it("treats empty and whitespace-only values as no value, never as text and never as a real value", () => {
    const blanks = [
      candidate(1, CITY, ""),
      candidate(2, CITY, "   "),
      candidate(3, CITY, null),
      candidate(4, CITY, "Salem"),
    ];
    mount(groupFor(blanks, CITY));

    expect(
      screen.getByRole("button", { name: "Show sources for No value extracted" }),
    ).toBeTruthy();
    expect(screen.getByText(/3 sources/)).toBeTruthy();
    expect(screen.getByText("Salem")).toBeTruthy();
    for (const strong of document.querySelectorAll("strong")) {
      expect(strong.textContent?.trim()).not.toBe("");
    }
    for (const button of screen.getAllByRole("button", { name: /Show sources/ })) {
      expect(button.getAttribute("aria-label")?.trim()).not.toMatch(/for$/);
    }
  });

  it("names a single blank observation as no value", () => {
    mount(groupFor([candidate(1, CITY, "  ")], CITY));

    expect(screen.getByText("No value extracted")).toBeTruthy();
  });

  it("renders a single observation as before, with no disclosure", () => {
    const only = candidate(1, CITY, "Salem");
    const { onSelectSource, onReviewDecision } = mount(groupFor([only], CITY));

    expect(screen.queryByRole("button", { name: /sources/ })).toBeNull();
    expect(screen.getByText("Salem")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Preview source/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review decision/ }));
    expect(onSelectSource).toHaveBeenCalledWith(only.id);
    expect(onReviewDecision).toHaveBeenCalledWith(only.id);
  });
});
