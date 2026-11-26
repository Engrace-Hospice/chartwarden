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
  const onReview = vi.fn();
  const view = render(<ReviewFieldGroup group={group} onReview={onReview} />);
  const refresh = (next: ReviewFieldGroupProjection): void =>
    view.rerender(<ReviewFieldGroup group={next} onReview={onReview} />);
  return { onReview, refresh, container: view.container };
}

const CITY = "patient.address.city";
const STREET = "patient.address.line1";
const REVIEW_BUTTON = /^Review .+, page \d+$/;

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

function rowFor(candidateId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-candidate-id="${candidateId}"]`);
  if (!row) throw new Error(`Expected a visible row for ${candidateId}`);
  return row;
}

describe("ReviewFieldGroup consolidation", () => {
  it("shows identical values once with a source count, a decided summary and a collapsed disclosure", () => {
    mount(groupFor(sixSalems(), CITY));

    expect(screen.getByText(/6 source observations · 3 decided/)).toBeTruthy();
    expect(screen.getByText(/6 sources/)).toBeTruthy();
    expect(screen.getByText(/3 of 6 decided/)).toBeTruthy();
    expect(screen.getAllByText("Salem")).toHaveLength(1);
    const disclosure = screen.getByRole("button", { name: "Sources for Salem" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: REVIEW_BUTTON })).toBeNull();
  });

  it("reveals every per-source row with its one Review button, and collapses again", () => {
    const candidates = sixSalems();
    const { onReview } = mount(groupFor(candidates, CITY));

    const disclosure = screen.getByRole("button", { name: "Sources for Salem" });
    fireEvent.click(disclosure);

    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("button", { name: REVIEW_BUTTON })).toHaveLength(6);
    expect(screen.getAllByRole("button")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: /Preview source|Review decision/ })).toBeNull();
    expect(screen.getByText(/Synthetic document 3 · Page 3 · 90% confidence/)).toBeTruthy();
    expect(screen.getAllByText("Approved")).toHaveLength(3);
    expect(screen.getAllByText("No decision recorded")).toHaveLength(3);

    const thirdRow = rowFor(candidates[2]?.id ?? "");
    const review = within(thirdRow).getByRole("button", { name: "Review SALEM, page 3" });
    expect(review.textContent?.trim()).toBe("Review");
    fireEvent.click(review);
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith(candidates[2]?.id, expect.any(HTMLElement));

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: REVIEW_BUTTON })).toBeNull();
  });

  it("keeps the toggle's accessible name fixed and lets aria-expanded carry the state", () => {
    mount(groupFor(sixSalems(), CITY));

    const disclosure = screen.getByRole("button", { name: "Sources for Salem" });
    expect(disclosure.textContent?.trim()).toBe("Sources");
    fireEvent.click(disclosure);

    expect(screen.getByRole("button", { name: "Sources for Salem" })).toBe(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.textContent?.trim()).toBe("Sources");
  });

  it("writes no normalised value into the DOM beyond what the reviewer already reads", () => {
    const { container } = mount(groupFor(sixSalems(), CITY));
    fireEvent.click(screen.getByRole("button", { name: "Sources for Salem" }));

    expect(container.querySelector("[data-value-key]")).toBeNull();
    for (const element of container.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames()) {
        expect(element.getAttribute(attribute)).not.toMatch(/salem/i);
      }
    }
    const controls = screen.getByRole("button", { name: "Sources for Salem" });
    expect(controls.getAttribute("aria-controls")).not.toMatch(/salem/i);
    expect(
      container.querySelector(`#${CSS.escape(controls.getAttribute("aria-controls") ?? "")}`),
    ).toBeTruthy();
  });

  it("offers no group-level decision control", () => {
    mount(groupFor(sixSalems(), CITY));
    fireEvent.click(screen.getByRole("button", { name: "Sources for Salem" }));

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
    expect(screen.getAllByRole("button", { name: /^Sources for/ })).toHaveLength(3);
  });

  it("expands one value without expanding another", () => {
    const street = [
      candidate(1, STREET, "1220 Alder St"),
      candidate(2, STREET, "1220 Alder St"),
      candidate(3, STREET, "1400 Harbor Blvd"),
      candidate(4, STREET, "1400 Harbor Blvd"),
    ];
    mount(groupFor(street, STREET));

    fireEvent.click(screen.getAllByRole("button", { name: /^Sources for/ })[0] as HTMLElement);

    expect(screen.getAllByRole("button", { name: REVIEW_BUTTON })).toHaveLength(2);
    const [expanded, collapsed] = screen.getAllByRole("button", { name: /^Sources for/ });
    expect(expanded?.getAttribute("aria-expanded")).toBe("true");
    expect(collapsed?.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not merge an approved correction with an identical extracted value", () => {
    const corrected = candidate(1, CITY, "Salem", {
      decision: decision("approve_with_edit", "Keizer"),
    });
    const extracted = [candidate(2, CITY, "Keizer"), candidate(3, CITY, "keizer ")];
    mount(groupFor([corrected, ...extracted], CITY));

    expect(screen.getByText("Approved correction")).toBeTruthy();
    expect(screen.getByText("Extracted: Salem")).toBeTruthy();
    const correctedRow = rowFor(corrected.id);
    expect(within(correctedRow).getByText("Keizer")).toBeTruthy();
    expect(
      within(correctedRow).getByRole("button", { name: "Review Keizer, page 1" }),
    ).toBeTruthy();
    expect(screen.getByText(/2 sources/)).toBeTruthy();
  });

  it("marks a single rejected observation as Rejected once, beside its value", () => {
    const rejected = candidate(1, CITY, "Salem", { decision: decision("reject") });
    mount(groupFor([rejected], CITY));

    const row = rowFor(rejected.id);
    const marker = within(row).getByText("Rejected");
    expect(within(row).getAllByText("Rejected")).toHaveLength(1);
    expect(marker.previousElementSibling?.textContent).toBe("Salem");
    expect(within(row).queryByText("No decision recorded")).toBeNull();
  });

  it("keeps a rejected observation out of a consolidated row of identical values", () => {
    const rejected = candidate(1, CITY, "Salem", { decision: decision("reject") });
    const open = [candidate(2, CITY, "Salem"), candidate(3, CITY, "Salem")];
    mount(groupFor([rejected, ...open], CITY));

    expect(within(rowFor(rejected.id)).getByText("Rejected")).toBeTruthy();
    expect(screen.getByText(/2 sources/)).toBeTruthy();
  });

  it("never merges withheld Part 2 observations, and never shows their value", () => {
    const withheld = [
      candidate(1, CITY, "Synthetic withheld text", { redacted: true }),
      candidate(2, CITY, "Synthetic withheld text", { redacted: true }),
    ];
    mount(groupFor(withheld, CITY));

    expect(screen.getAllByText("Part 2 content withheld")).toHaveLength(2);
    expect(screen.queryByText(/Synthetic withheld text/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sources for/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Review Part 2 content withheld, page 1" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review Part 2 content withheld, page 2" }),
    ).toBeTruthy();
  });

  it("treats empty and whitespace-only values as no value, never as text and never as a real value", () => {
    const blanks = [
      candidate(1, CITY, ""),
      candidate(2, CITY, "   "),
      candidate(3, CITY, null),
      candidate(4, CITY, "Salem"),
    ];
    mount(groupFor(blanks, CITY));

    expect(screen.getByRole("button", { name: "Sources for No value extracted" })).toBeTruthy();
    expect(screen.getByText(/3 sources/)).toBeTruthy();
    expect(screen.getByText("Salem")).toBeTruthy();
    for (const strong of document.querySelectorAll("strong")) {
      expect(strong.textContent?.trim()).not.toBe("");
    }
    for (const button of screen.getAllByRole("button", { name: /^Sources for/ })) {
      const name = document.getElementById(button.getAttribute("aria-labelledby") ?? "");
      expect(name?.textContent?.trim()).not.toMatch(/for$/);
    }
  });

  it("names a single blank observation as no value, in the row and in its Review button", () => {
    mount(groupFor([candidate(1, CITY, "  ")], CITY));

    expect(screen.getByText("No value extracted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review No value extracted, page 1" })).toBeTruthy();
  });

  it("renders a single observation with one Review button and no disclosure", () => {
    const only = candidate(1, CITY, "Salem");
    const { onReview } = mount(groupFor([only], CITY));

    expect(screen.queryByRole("button", { name: /^Sources/ })).toBeNull();
    expect(screen.getByText("Salem")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review Salem, page 1" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith(only.id, expect.any(HTMLElement));
  });
});

describe("ReviewFieldGroup consolidated details", () => {
  it("names the original extractions behind a consolidated correction without expanding it", () => {
    const corrections = [
      candidate(1, CITY, "Salem", { decision: decision("approve_with_edit", "Keizer") }),
      candidate(2, CITY, "Salm", { decision: decision("approve_with_edit", " keizer") }),
      candidate(3, CITY, "SALEM", { decision: decision("approve_with_edit", "Keizer") }),
    ];
    mount(groupFor(corrections, CITY));

    expect(screen.getByText("Keizer")).toBeTruthy();
    expect(screen.getByText("Approved correction")).toBeTruthy();
    expect(screen.getByText("Extracted: Salem, Salm")).toBeTruthy();
    expect(screen.getByText("3 sources · 3 of 3 decided")).toBeTruthy();
    expect(screen.queryByRole("button", { name: REVIEW_BUTTON })).toBeNull();
  });

  it("shows the Approved correction badge and each row's own original once expanded", () => {
    const corrections = [
      candidate(1, CITY, "Salem", { decision: decision("approve_with_edit", "Keizer") }),
      candidate(2, CITY, "Salm", { decision: decision("approve_with_edit", "Keizer") }),
    ];
    mount(groupFor(corrections, CITY));
    fireEvent.click(screen.getByRole("button", { name: "Sources for Keizer" }));

    expect(screen.getAllByText("Approved correction")).toHaveLength(3);
    expect(within(rowFor(corrections[0]?.id ?? "")).getByText("Extracted: Salem")).toBeTruthy();
    expect(within(rowFor(corrections[1]?.id ?? "")).getByText("Extracted: Salm")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Review Keizer, page 1" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: REVIEW_BUTTON })).toHaveLength(2);
  });

  it("shows the Rejected badge on a consolidated rejection, with no Extracted line", () => {
    const rejections = [
      candidate(1, CITY, "Salem", { decision: decision("reject") }),
      candidate(2, CITY, "salem", { decision: decision("reject") }),
    ];
    mount(groupFor(rejections, CITY));

    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(screen.getByText("2 sources · 2 of 2 decided")).toBeTruthy();
    expect(screen.queryByText(/Extracted:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sources for Salem" }));
    expect(screen.getAllByText("Rejected")).toHaveLength(3);
  });

  it("counts the vision disagreements inside a consolidated row", () => {
    const disagreed = { status: "disagreed", observedValue: "Keizer" } as const;
    mount(
      groupFor(
        [
          candidate(1, CITY, "Salem"),
          candidate(2, CITY, "Salem", { vision: disagreed }),
          candidate(3, CITY, "Salem", { vision: disagreed }),
        ],
        CITY,
      ),
    );

    expect(screen.getByText("3 sources · 0 of 3 decided · Vision disagreement (2)")).toBeTruthy();
  });

  it("flags a vision disagreement on a single row", () => {
    mount(
      groupFor(
        [candidate(1, CITY, "Salem", { vision: { status: "disagreed", observedValue: "Keizer" } })],
        CITY,
      ),
    );

    expect(screen.getByText("No decision recorded · Vision disagreement")).toBeTruthy();
  });

  it("keeps a disclosure open when the workspace refreshes with the same values", () => {
    const { refresh } = mount(groupFor(sixSalems(), CITY));
    fireEvent.click(screen.getByRole("button", { name: "Sources for Salem" }));
    expect(screen.getAllByRole("button", { name: REVIEW_BUTTON })).toHaveLength(6);

    const refreshed = sixSalems().map((item) => ({ ...item, decision: decision("approve") }));
    refresh(groupFor(refreshed, CITY));

    const disclosure = screen.getByRole("button", { name: "Sources for Salem" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("button", { name: REVIEW_BUTTON })).toHaveLength(6);
    expect(screen.getByText("6 sources · 6 of 6 decided")).toBeTruthy();
  });

  it("collapses a disclosure whose value changes key, as when an approval becomes a correction", () => {
    const pair = [candidate(1, CITY, "Salem"), candidate(2, CITY, "Salem")];
    const { refresh } = mount(groupFor(pair, CITY));
    fireEvent.click(screen.getByRole("button", { name: "Sources for Salem" }));
    expect(screen.getAllByRole("button", { name: REVIEW_BUTTON })).toHaveLength(2);

    refresh(
      groupFor(
        pair.map((item) => ({ ...item, decision: decision("approve_with_edit", "Keizer") })),
        CITY,
      ),
    );

    const disclosure = screen.getByRole("button", { name: "Sources for Keizer" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: REVIEW_BUTTON })).toBeNull();
    expect(screen.getByText("Extracted: Salem")).toBeTruthy();
  });
});
