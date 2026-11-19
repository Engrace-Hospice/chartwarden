// @vitest-environment jsdom
// The Clinical tab's "Recent Clinical Notes" (ADR-0114 VN-D30, S1 PR E3): the summary is read from the structured note view, so a withheld
// note shows as withheld and never as the legacy string (which carries a generic withheld sentence); a note whose Part 2 check could not
// be decided (503 NOTE_VIEW_UNAVAILABLE) keeps its row, says so, and can be read again. Synthetic data only.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClinicalTab, useClinicalData } from "./patient-clinical";
import type { PatientChartData, PatientSummary } from "./patient-overview";

afterEach(cleanup);

const ENCOUNTER = "/api/v1/encounters/{encounterId}";
const patient = { id: "p1" } as unknown as PatientSummary;
// A stand-in for the legacy string: it must never reach the screen when the structured view is present.
const LEGACY = "LEGACY STRING that must not show.";

const summary = (id: string, serviceDate: string) => ({
  id,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate,
  status: "signed",
  authoredByUserId: "mem-1",
  signedAt: `${serviceDate}T10:00:00Z`,
});
const chart = {
  encounters: [summary("e1", "2026-10-03"), summary("e2", "2026-10-02")],
} as unknown as PatientChartData;

const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
const noteViewUnavailable = () => ({
  data: undefined,
  error: { error: { code: "NOTE_VIEW_UNAVAILABLE", message: "cannot be decided" } },
  response: { status: 503 },
});
const detail = (id: string, over: Record<string, unknown> = {}) =>
  ok({
    id,
    serviceDate: id === "e1" ? "2026-10-03" : "2026-10-02",
    encounterType: "routine_visit",
    discipline: "rn",
    status: "signed",
    authoredByUserId: "mem-1",
    finalDocumentation: LEGACY,
    vitals: null,
    ...over,
  });
const sectionOf = (sectionId: string | null, over: Record<string, unknown> = {}) => ({
  sectionId,
  text: `Text of ${sectionId}.`,
  withheld: false,
  amendedByAddendumId: null,
  signedAt: null,
  ...over,
});

// The tab's other reads, answered as a healthy chart would (the notes are what these tests are about).
const OTHER_READS: Record<string, unknown> = {
  "/api/v1/patients/{patientId}/scales/{scaleType}/latest": ok({
    id: "a",
    scaleType: "pps",
    score: 60,
    capturedAt: "2026-10-01T00:00:00Z",
    data: {},
  }),
  "/api/v1/patients/{patientId}/consents": ok({ data: [] }),
  "/api/v1/patients/{patientId}/dpoa/active-primary": ok({ data: null }),
};

function Harness() {
  const clinical = useClinicalData("p1", chart, true);
  return <ClinicalTab patient={patient} data={chart} clinical={clinical} />;
}

function mount(replies: Record<string, () => unknown>) {
  const get = vi.fn((path: string, init?: { params?: { path?: { encounterId?: string } } }) => {
    if (path === ENCOUNTER) {
      const id = init?.params?.path?.encounterId ?? "";
      return Promise.resolve((replies[id] ?? (() => ok({})))());
    }
    return Promise.resolve(OTHER_READS[path] ?? ok({}));
  });
  render(
    <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return get;
}

const notesPanel = async () =>
  within((await screen.findByText("Recent Clinical Notes")).closest("section") as HTMLElement);
/** The data rows, newest visit first: 1 is the 3 October note (e1), 2 the 2 October note (e2); 0 is the header. */
const rowAt = async (index: number) => {
  const panel = await notesPanel();
  await waitFor(() => expect(panel.getAllByRole("row").length).toBeGreaterThan(index));
  return within(panel.getAllByRole("row")[index] as HTMLElement);
};

describe("a note's summary in the recent notes", () => {
  it("is the visible text of the structured view, never the legacy string", async () => {
    mount({
      e1: () =>
        detail("e1", {
          finalDocumentationView: {
            withheld: false,
            sections: [sectionOf("pain", { text: "Pain controlled on the current regimen." })],
          },
        }),
      e2: () => detail("e2", { finalDocumentation: "Older legacy summary." }),
    });
    expect(await screen.findByText("Pain controlled on the current regimen.")).toBeInTheDocument();
    expect(screen.queryByText(LEGACY)).toBeNull();
    // An older API that sends no structured view keeps its legacy summary.
    expect(await screen.findByText("Older legacy summary.")).toBeInTheDocument();
  });

  it("says Withheld for a whole withheld note, and shows no legacy text", async () => {
    mount({
      e1: () => detail("e1", { finalDocumentationView: { withheld: true, sections: [] } }),
      e2: () => detail("e2", { finalDocumentationView: null, finalDocumentation: null }),
    });
    await screen.findByText("Withheld");
    expect(screen.queryByText(LEGACY)).toBeNull();
  });

  it("says Withheld when every section is withheld", async () => {
    mount({
      e1: () =>
        detail("e1", {
          finalDocumentationView: {
            withheld: false,
            sections: [sectionOf("sud", { text: null, withheld: true })],
          },
        }),
    });
    await screen.findByText("Withheld");
    expect(screen.queryByText(LEGACY)).toBeNull();
  });

  it("shows the readable text and says some sections are withheld", async () => {
    mount({
      e1: () =>
        detail("e1", {
          finalDocumentationView: {
            withheld: false,
            sections: [
              sectionOf("pain", { text: "Pain controlled." }),
              sectionOf("sud", { text: null, withheld: true }),
            ],
          },
        }),
    });
    expect(await screen.findByText("Pain controlled.")).toBeInTheDocument();
    expect(screen.getByText("Some sections withheld")).toBeInTheDocument();
  });
});

describe("a note whose Part 2 check could not be decided", () => {
  it("keeps its row, says the note cannot be shown, and reads it again on request", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const get = mount({
      e1: () => {
        reads += 1;
        return reads === 1
          ? noteViewUnavailable()
          : detail("e1", {
              finalDocumentationView: {
                withheld: false,
                sections: [sectionOf("pain", { text: "Pain controlled now." })],
              },
            });
      },
      e2: () =>
        detail("e2", {
          finalDocumentationView: {
            withheld: false,
            sections: [sectionOf("plan", { text: "Plan unchanged." })],
          },
        }),
    });
    const row = await rowAt(1);
    expect(await row.findByText("The note cannot be shown right now")).toBeInTheDocument();
    // The other row is not held back by it.
    expect(await screen.findByText("Plan unchanged.")).toBeInTheDocument();
    await user.click(row.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Pain controlled now.")).toBeInTheDocument();
    expect(screen.queryByText("The note cannot be shown right now")).toBeNull();
    // Only the one note was read again.
    expect(get.mock.calls.filter(([p]) => p === ENCOUNTER)).toHaveLength(3);
  });

  it("keeps the retry focusable while the note is read again, and says so in a region that was already there", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    mount({
      e1: () => {
        reads += 1;
        // The first read is refused at once; the retry's read waits for the test.
        return reads === 1 ? noteViewUnavailable() : held.then(() => noteViewUnavailable());
      },
      e2: () => detail("e2", { finalDocumentation: "Other." }),
    });
    const row = await rowAt(1);
    const retry = await row.findByRole("button", { name: /Try again/ });
    const status = retry.parentElement?.querySelector("output") as HTMLOutputElement;
    expect(status).not.toBeNull();
    expect(status.textContent).toBe("");

    await user.click(retry);
    await waitFor(() => expect(retry).toHaveAttribute("aria-disabled", "true"));
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveFocus();
    expect(status.textContent).toMatch(/reading the note again/i);
    await user.click(retry);
    expect(reads).toBe(2);

    release();
    await waitFor(() => expect(status.textContent).toMatch(/Still not available/));
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(retry).toHaveFocus();
  });

  it("says so again when the retry is refused the same way, and offers the retry again", async () => {
    const user = userEvent.setup();
    mount({
      e1: () => noteViewUnavailable(),
      e2: () => detail("e2", { finalDocumentation: "Other." }),
    });
    const row = await rowAt(1);
    await user.click(await row.findByRole("button", { name: /Try again/ }));
    expect(await row.findByText(/Still not available/)).toBeInTheDocument();
    await waitFor(() => expect(row.getByRole("button", { name: /Try again/ })).toBeEnabled());
  });
});
