import { readFileSync } from "node:fs";
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate, PlatformSupportAccess, Workspace } from "../doclens-api";
import { ReviewSourcePanel } from "./review-source-panel";

const BATCH = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CANDIDATE_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const NATURAL_WIDTH = 1224;

type Decision = NonNullable<Candidate["decision"]>;

function savedDecision(kind: Decision["decision"], editedValue: string | null = null): Decision {
  return {
    id: "decision-1",
    decision: kind,
    editedValue,
    reason: null,
    partOfBulkApprove: false,
    decidedAt: "2026-11-22T11:00:00.000Z",
  };
}

function makeWorkspace(
  candidateOverrides: Partial<Candidate> = {},
  review: Workspace["review"] = {
    id: "review-1",
    status: "in_progress",
    reviewerMembershipId: "membership-1",
    isMine: true,
  },
): Workspace {
  return {
    batch: {
      id: BATCH,
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
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        documentType: "discharge_summary",
        confidence: 0.98,
        needsHumanClassification: false,
      },
    ],
    documents: [],
    jobs: [],
    review,
    candidates: [
      {
        id: CANDIDATE_ID,
        jobId: "job-1",
        documentType: "discharge_summary",
        fieldPath: "patient.address.city",
        description: "city",
        riskLevel: "low",
        confidence: 0.95,
        value: "Salem",
        page: 1,
        bbox: [61.2, 79.2, 306, 118.8],
        vision: { status: "not_required", observedValue: null },
        sudDetected: false,
        codingFlags: [],
        writebackTarget: true,
        redacted: false,
        decision: null,
        ...candidateOverrides,
      },
    ],
  };
}

const decisionRequests: { decision: string; editedValue?: string }[] = [];
let serverWorkspace: Workspace = makeWorkspace();

const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), "http://localhost").toString());
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/decisions")) {
    const body = (await request.clone().json()) as {
      decision: Decision["decision"];
      editedValue?: string;
    };
    decisionRequests.push(body);
    serverWorkspace = {
      ...serverWorkspace,
      candidates: serverWorkspace.candidates.map((candidate) => ({
        ...candidate,
        decision: savedDecision(body.decision, body.editedValue ?? null),
      })),
    };
  }
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

function Harness({
  initial,
  supportAccess = null,
}: {
  initial: Workspace;
  supportAccess?: PlatformSupportAccess | null;
}): JSX.Element {
  const [workspace, setWorkspace] = useState(initial);
  const candidate = workspace.candidates[0] as Candidate;
  return (
    <ReviewSourcePanel
      batchId={BATCH}
      workspace={workspace}
      candidate={candidate}
      returnTo={null}
      onClose={() => undefined}
      onAvailabilityChange={() => undefined}
      refresh={async () => {
        setWorkspace(serverWorkspace);
        return serverWorkspace;
      }}
      onDecisionSaved={() => undefined}
      nextCandidate={null}
      onNext={() => undefined}
      supportAccess={supportAccess}
    />
  );
}

function mount(
  workspace: Workspace,
  options: { supportAccess?: PlatformSupportAccess | null } = {},
): void {
  serverWorkspace = workspace;
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <MemoryRouter>
        <Harness initial={workspace} supportAccess={options.supportAccess ?? null} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

function loadSource(): HTMLImageElement {
  const image = screen.getByRole("img", { name: /Page 1 of the source document/ });
  Object.defineProperty(image, "naturalWidth", { value: NATURAL_WIDTH, configurable: true });
  fireEvent.load(image);
  return image as HTMLImageElement;
}

/** Replaces a jsdom accessor on HTMLImageElement.prototype and returns a function that restores it. */
function overrideImageProperty(name: "complete" | "naturalWidth", value: unknown): () => void {
  const proto = HTMLImageElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(proto, name, original);
    else Reflect.deleteProperty(proto, name);
  };
}

const STYLESHEET = readFileSync(
  "apps/web/src/modules/22-documents/unified-review/unified-review.css",
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the last rule whose selector list contains exactly `selector`. */
function ruleBody(selector: string): string {
  const rules = [...STYLESHEET.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, selectors]) =>
    (selectors ?? "").split(",").some((candidate) => candidate.trim() === selector),
  );
  return rules.at(-1)?.[2] ?? "";
}

const confirmation = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: /I compared this with the source/ });
const accept = (): HTMLElement => screen.getByRole("button", { name: "Accept extracted value" });
const edit = (): HTMLElement => screen.getByRole("button", { name: "Edit value" });
const reject = (): HTMLElement => screen.getByRole("button", { name: "Reject extracted value" });

beforeEach(() => {
  decisionRequests.length = 0;
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReviewSourcePanel source viewer", () => {
  it("treats a page image that finished loading before the effects ran as loaded", () => {
    // A cached image fires `load` before React's passive reset effect; the reset must not undo it.
    const restoreComplete = overrideImageProperty("complete", true);
    const restoreWidth = overrideImageProperty("naturalWidth", NATURAL_WIDTH);
    try {
      mount(makeWorkspace());

      expect(screen.getByText("Source loaded")).toBeTruthy();
      expect(document.querySelector<HTMLElement>(".wx-unified-source-sheet")?.style.maxWidth).toBe(
        `${NATURAL_WIDTH}px`,
      );
    } finally {
      restoreWidth();
      restoreComplete();
    }
  });

  it("restores the jsdom image accessors it overrides", () => {
    const proto = HTMLImageElement.prototype;
    const before = {
      complete: Object.getOwnPropertyDescriptor(proto, "complete"),
      naturalWidth: Object.getOwnPropertyDescriptor(proto, "naturalWidth"),
    };

    overrideImageProperty("complete", true)();
    overrideImageProperty("naturalWidth", NATURAL_WIDTH)();

    expect(Object.getOwnPropertyDescriptor(proto, "complete")).toEqual(before.complete);
    expect(Object.getOwnPropertyDescriptor(proto, "naturalWidth")).toEqual(before.naturalWidth);
  });

  it("shows the page at the panel width, capped at its natural width", () => {
    mount(makeWorkspace());
    loadSource();

    const page = document.querySelector<HTMLElement>(".wx-unified-source-sheet");
    expect(page?.style.maxWidth).toBe(`${NATURAL_WIDTH}px`);
    expect(page?.style.width).toBe("");
    const zoom = screen.getByRole("group", { name: "Source zoom" });
    expect(
      within(zoom).getByRole("button", { name: "Fit width" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(zoom).getByRole("button", { name: "Actual size" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("switches to actual size and back to fit width", () => {
    mount(makeWorkspace());
    loadSource();
    const page = document.querySelector<HTMLElement>(".wx-unified-source-sheet");

    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(page?.style.width).toBe(`${NATURAL_WIDTH}px`);
    expect(screen.getByRole("button", { name: "Actual size" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(page?.style.width).toBe("");
    expect(page?.style.maxWidth).toBe(`${NATURAL_WIDTH}px`);
  });

  it("positions the highlight with the same percentage coordinates at any scale", () => {
    mount(makeWorkspace());
    loadSource();

    const box = document.querySelector<HTMLElement>(".wx-unified-source-box");
    expect(box).toBeTruthy();
    expect(box?.style.left).toBe("10%");
    expect(box?.style.top).toBe("10%");
    expect(box?.style.width).toBe("40%");
    expect(box?.style.height).toBe("5%");
    expect(box?.getAttribute("aria-hidden")).toBe("true");
  });

  it("styles the highlight as a translucent, border-free box with an outside outline", () => {
    const box = ruleBody(".wx-unified-source-box");
    expect(box).toMatch(/box-sizing:\s*border-box/);
    expect(box).not.toMatch(/(^|[;\s])border(-width)?\s*:/);
    expect(box).toMatch(/outline:\s*[^;]+/);
    expect(box).toMatch(/outline-offset:\s*[^;]+/);
    expect(box).toMatch(/min-height:\s*[^;]+/);
    expect(box).toMatch(/background:\s*color-mix\(.*transparent\)/);
  });

  it("scrolls and fills the width inside the review task viewer only", () => {
    expect(ruleBody(".wx-unified-source-viewport")).toMatch(/max-height:\s*[^;]+/);
    expect(ruleBody(".wx-unified-source-viewport")).toMatch(/overflow:\s*auto/);
    const image = ruleBody(".wx-unified-source-sheet > img");
    expect(image).not.toMatch(/max-height/);
    expect(image).toMatch(/width:\s*100%/);
  });

  it("renders the review task viewer without the shared safeguard stage classes", () => {
    mount(makeWorkspace());
    loadSource();

    expect(document.querySelector(".wx-unified-source-viewer")).toBeTruthy();
    expect(document.querySelector(".wx-unified-source-stage")).toBeNull();
    expect(document.querySelector(".wx-unified-source-page")).toBeNull();
  });
});

// The safeguard panel (review-safeguard-panel.tsx) still renders its evidence with these shared
// classes; the viewer redesign must not take away its scroll box or its pinned status pill.
describe("shared source stage rules used by the safeguard panel", () => {
  it("keeps the stage scrollable and height-capped", () => {
    const stage = ruleBody(".wx-unified-source-stage");
    expect(stage).toMatch(/max-height:\s*30rem/);
    expect(stage).toMatch(/overflow:\s*auto/);
  });

  it("keeps the evidence page image height-capped", () => {
    const image = ruleBody(".wx-unified-source-page > img");
    expect(image).toMatch(/max-height:\s*26rem/);
    expect(image).toMatch(/max-width:\s*100%/);
  });

  it("keeps the status pill pinned over the stage", () => {
    expect(ruleBody(".wx-unified-source-stage > .wx-status-pill")).toMatch(/position:\s*absolute/);
  });

  it("is still the markup the safeguard panel renders", () => {
    const safeguard = readFileSync(
      "apps/web/src/modules/22-documents/unified-review/review-safeguard-panel.tsx",
      "utf8",
    );
    expect(safeguard).toContain('className="wx-unified-source-stage"');
    expect(safeguard).toContain('className="wx-unified-source-page"');
  });
});

describe("ReviewSourcePanel after a saved decision", () => {
  async function saveCorrection(value: string): Promise<void> {
    loadSource();
    fireEvent.click(confirmation());
    fireEvent.click(edit());
    fireEvent.change(screen.getByLabelText("Corrected value"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save corrected value" }));
    expect(await screen.findByText(`Decision saved: corrected to ${value}`)).toBeTruthy();
  }

  it("shows the corrected value in the header and clears the comparison", async () => {
    mount(makeWorkspace());
    await saveCorrection("Keizer");

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.querySelector("p")?.textContent).toMatch(/^Keizer · /);
    expect(header?.textContent).toContain("Saved decision: Edited");
    expect(header?.textContent).toContain("Extracted: Salem");
    expect(confirmation().checked).toBe(false);
  });

  it("locks the three decision buttons until Change decision is chosen", async () => {
    mount(makeWorkspace());
    await saveCorrection("Keizer");

    expect(accept()).toBeDisabled();
    expect(edit()).toBeDisabled();
    expect(reject()).toBeDisabled();
    expect(confirmation()).toBeDisabled();
    fireEvent.click(accept());
    expect(decisionRequests).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Change decision" }));
    expect(screen.queryByRole("button", { name: "Change decision" })).toBeNull();
    expect(confirmation()).not.toBeDisabled();
    expect(confirmation().checked).toBe(false);
    expect(accept()).toBeDisabled();

    fireEvent.click(confirmation());
    expect(accept()).not.toBeDisabled();
    expect(edit()).not.toBeDisabled();
    expect(reject()).not.toBeDisabled();
  });

  it("moves focus to the comparison checkbox when Change decision is chosen", async () => {
    mount(makeWorkspace());
    await saveCorrection("Keizer");

    const change = screen.getByRole("button", { name: "Change decision" });
    change.focus();
    fireEvent.click(change);

    await waitFor(() => expect(document.activeElement).toBe(confirmation()));
  });

  it("locks again after the changed decision is saved", async () => {
    mount(makeWorkspace());
    await saveCorrection("Keizer");
    fireEvent.click(screen.getByRole("button", { name: "Change decision" }));
    fireEvent.click(confirmation());
    fireEvent.click(accept());

    expect(await screen.findByText(/Decision saved: accepted Salem/)).toBeTruthy();
    expect(decisionRequests).toHaveLength(2);
    await waitFor(() => expect(accept()).toBeDisabled());
    expect(confirmation().checked).toBe(false);
    expect(screen.getByRole("button", { name: "Change decision" })).toBeTruthy();
  });

  it("opens an already decided observation locked, with its saved state in the header", () => {
    mount(makeWorkspace({ decision: savedDecision("approve_with_edit", "Keizer") }));
    loadSource();

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.textContent).toContain("Keizer");
    expect(header?.textContent).toContain("Extracted: Salem");
    expect(confirmation()).toBeDisabled();
    expect(accept()).toBeDisabled();
    expect(edit()).toBeDisabled();
    expect(reject()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change decision" })).toBeTruthy();
  });

  it("states an accepted decision in the header without changing the value", () => {
    mount(makeWorkspace({ decision: savedDecision("approve") }));

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.textContent).toContain("Salem");
    expect(header?.textContent).toContain("Saved decision: Approved");
  });

  it("offers a first decision on an undecided observation without Change decision", () => {
    mount(makeWorkspace());
    loadSource();

    expect(screen.queryByRole("button", { name: "Change decision" })).toBeNull();
    fireEvent.click(confirmation());
    expect(accept()).not.toBeDisabled();
  });
});

describe("ReviewSourcePanel protected and empty values", () => {
  const WITHHELD = "WITHHELD-SYNTHETIC-VALUE";
  const CORRECTED = "CORRECTED-SYNTHETIC-VALUE";

  it("shows no value in the header of a withheld Part 2 observation", () => {
    mount(makeWorkspace({ redacted: true, value: WITHHELD }));

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.querySelector("p")?.textContent).toMatch(/^Protected value withheld · /);
    expect(header?.textContent).not.toContain(WITHHELD);
  });

  it("shows neither a saved-decision line nor any value for a withheld observation", () => {
    mount(
      makeWorkspace({
        redacted: true,
        value: WITHHELD,
        decision: savedDecision("approve_with_edit", CORRECTED),
      }),
    );

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.textContent).not.toContain("Saved decision");
    expect(header?.textContent).not.toContain(WITHHELD);
    expect(header?.textContent).not.toContain(CORRECTED);
    expect(document.body.textContent).not.toContain(WITHHELD);
    expect(document.body.textContent).not.toContain(CORRECTED);
  });

  it.each([
    ["an empty", ""],
    ["a whitespace-only", "   "],
  ])("names %s extracted value as no value in the header", (_label, value) => {
    mount(makeWorkspace({ value }));

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.querySelector("p")?.textContent).toMatch(/^No value extracted · /);
  });
});

describe("ReviewSourcePanel footer copy", () => {
  const CHECKBOX_COPY = /comparison checkbox/;

  it("keeps the checkbox requirement when decisions are available", () => {
    mount(makeWorkspace());

    expect(screen.getByText(CHECKBOX_COPY)).toBeTruthy();
  });

  it("does not mention a checkbox when another reviewer owns the review", () => {
    mount(
      makeWorkspace(
        {},
        { id: "review-1", status: "in_progress", reviewerMembershipId: "other", isMine: false },
      ),
    );

    expect(screen.getByText("Another reviewer owns this review.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });

  it("does not mention a checkbox once the review is complete", () => {
    mount(
      makeWorkspace(
        {},
        { id: "review-1", status: "complete", reviewerMembershipId: "m", isMine: true },
      ),
    );

    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });

  it("does not mention a checkbox in a read-only support session", () => {
    mount(makeWorkspace(), {
      supportAccess: {
        organizationId: "cccccccc-3333-4333-8333-cccccccccccc",
        supportSessionId: "s-1",
      },
    });

    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });

  it("does not mention a checkbox for withheld Part 2 content", () => {
    mount(makeWorkspace({ redacted: true }));

    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });
});
