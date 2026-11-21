// Workflow 09, WP1 — the visit context header (T01, T02, T22, T36): which encounter and visit this is, ONE way back, and the Document /
// Review / Complete strip. Rendered on its own, with the screens' two anchors stood in by plain elements.
import { ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { COMPLETE_ANCHOR_ID, REVIEW_ANCHOR_ID } from "../jump-to-anchor";
import { type VisitContextEncounter, VisitContextHeader } from "../visit-context-header";

const encounter: VisitContextEncounter = {
  id: "enc-1",
  patientId: "patient-1",
  visitId: "visit-1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status: "draft",
  lateEntryTier: "normal",
  isF2f: false,
};

const visit = {
  id: "visit-1",
  scheduledStartedAt: "2026-08-31T14:00:00.000Z",
  scheduledEndedAt: "2026-08-31T15:00:00.000Z",
  assignedMembershipId: "mem-9",
};

interface Reads {
  visit?: unknown;
  staff?: unknown;
  /** Make the named read reject, as a network failure does. */
  reject?: "visit" | "staff";
}

function fakeClient({ visit: visitBody = visit, staff, reject }: Reads = {}) {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/visits/{visitId}") {
        if (reject === "visit") throw new TypeError("offline");
        return { data: visitBody };
      }
      if (path === "/api/v1/scheduling/staff") {
        if (reject === "staff") throw new TypeError("offline");
        return { data: staff };
      }
      return { data: null };
    }),
  };
}

function Where(): JSX.Element {
  const { pathname, search, hash } = useLocation();
  return <output aria-label="location">{`${pathname}${search}${hash}`}</output>;
}

interface HeaderProps {
  screen: "compose" | "record";
  encounter: VisitContextEncounter;
  canAuthor: boolean;
}

function headerTree(
  props: Partial<HeaderProps>,
  path: string,
  client: ReturnType<typeof fakeClient>,
) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <ApiClientProvider client={client as never}>
        <Where />
        <Routes>
          <Route
            path="*"
            element={
              <>
                <VisitContextHeader
                  screen={props.screen ?? "record"}
                  encounter={props.encounter ?? encounter}
                  canAuthor={props.canAuthor ?? true}
                />
                <section id={REVIEW_ANCHOR_ID} tabIndex={-1} aria-label="Review target" />
                <section id={COMPLETE_ANCHOR_ID} tabIndex={-1} aria-label="Complete target" />
              </>
            }
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>
  );
}

function renderHeader(
  props: Partial<HeaderProps> = {},
  path = "/x",
  client = fakeClient({ staff: [{ membershipId: "mem-9", displayName: "Nora Nurse" }] }),
) {
  const view = render(headerTree(props, path, client));
  const withProps = (next: Partial<HeaderProps>) => view.rerender(headerTree(next, path, client));
  return { ...view, client, withProps };
}

const from = (path: string) => `/x?from=${encodeURIComponent(path)}`;

describe("the encounter and the visit", () => {
  it("names the encounter by its type, discipline, service date and the server's status (T22)", () => {
    renderHeader();
    const header = screen.getByRole("region", { name: "Visit context" });
    expect(within(header).getByText("Routine Visit")).toBeTruthy();
    expect(within(header).getByText("Rn")).toBeTruthy();
    expect(within(header).getByText("2026-08-31")).toBeTruthy();
    expect(within(header).getByText("Draft")).toBeTruthy();
    expect(within(header).queryByText("Normal")).toBeNull();
  });

  it("shows a late-entry tier only when the note is late, and the status as the server returned it", () => {
    renderHeader({
      encounter: {
        ...encounter,
        status: "cosign_pending",
        lateEntryTier: "significant_late_entry",
      },
    });
    expect(screen.getByText("Cosign Pending")).toBeTruthy();
    expect(screen.getByText("Significant Late Entry")).toBeTruthy();
  });

  it("adds the scheduled window and the clinician once the visit has been read, with a link to the visit (T01)", async () => {
    renderHeader();
    expect(await screen.findByText("Nora Nurse")).toBeTruthy();
    const line = screen.getByText("Scheduled visit").closest("p") as HTMLElement;
    expect(within(line).getByRole("link", { name: "Open visit" }).getAttribute("href")).toBe(
      "/scheduling/visits/visit-1",
    );
    expect(line.textContent).toMatch(/Aug 31/);
  });

  it("forwards the way back to the visit, so the visit's Back leads to where this screen was opened from (R13)", async () => {
    const origin = "/me/visits?status=completed&page=2";
    renderHeader({}, from(origin));
    expect(screen.getByRole("link", { name: "Open visit" }).getAttribute("href")).toBe(
      `/scheduling/visits/visit-1?from=${encodeURIComponent(origin)}`,
    );
    await screen.findByText("Nora Nurse");
  });

  it("opens the visit as it was when this screen was opened from it, rather than pointing the visit at itself", async () => {
    const origin = `/scheduling/visits/visit-1?from=${encodeURIComponent("/me/visits")}`;
    renderHeader({}, from(origin));
    expect(screen.getByRole("link", { name: "Open visit" }).getAttribute("href")).toBe(origin);
    await screen.findByText("Nora Nurse");
  });

  it.each([
    ["the visit cannot be read", fakeClient({ reject: "visit" })],
    ["the visit answers nothing usable", fakeClient({ visit: { id: "visit-1" } })],
    ["the staff list cannot be read", fakeClient({ reject: "staff" })],
  ])("still shows the visit link, and no error, when %s", async (_name, client) => {
    renderHeader({}, "/x", client);
    await waitFor(() => expect(client.GET).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Open visit" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Nora Nurse")).toBeNull();
  });

  it("reads no visit for a PRN encounter and says so", () => {
    const { client } = renderHeader({ encounter: { ...encounter, visitId: null } });
    expect(screen.getByText("PRN / unscheduled")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open visit" })).toBeNull();
    expect(client.GET).not.toHaveBeenCalled();
  });
});

describe("the way back (T36)", () => {
  it.each([
    ["/me/visits?status=completed", "Back to My Visits", "/me/visits?status=completed"],
    ["/work/drafts", "Back to My Notes", "/work/drafts"],
    ["/work/cosignatures", "Back to Cosignature queue", "/work/cosignatures"],
    ["/patients/patient-1/encounters", "Back to Encounters", "/patients/patient-1/encounters"],
    ["/scheduling/visits/visit-1", "Back to the visit", "/scheduling/visits/visit-1"],
    [
      "/calendar?view=week&date=2026-08-31",
      "Back to Calendar",
      "/calendar?view=week&date=2026-08-31",
    ],
  ])("goes back to %s", (origin, text, href) => {
    renderHeader({}, from(origin));
    expect(screen.getAllByRole("link", { name: /^Back to/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: text }).getAttribute("href")).toBe(href);
  });

  it("falls back to the screen's own default when there is no origin", () => {
    renderHeader({ screen: "record" });
    expect(screen.getByRole("link", { name: "Back to encounters" }).getAttribute("href")).toBe(
      "/patients/patient-1/encounters",
    );
  });

  it("sends the composer to its record by default, and keeps the record one click away when Back leaves the encounter", () => {
    const first = renderHeader({ screen: "compose" });
    expect(screen.getByRole("link", { name: "Back to encounter" }).getAttribute("href")).toBe(
      "/patients/patient-1/encounters/enc-1",
    );
    expect(screen.queryByRole("link", { name: "Encounter record" })).toBeNull();
    first.unmount();

    renderHeader({ screen: "compose" }, from("/me/visits"));
    expect(screen.getByRole("link", { name: "Back to My Visits" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Encounter record" }).getAttribute("href")).toBe(
      `/patients/patient-1/encounters/enc-1?from=${encodeURIComponent("/me/visits")}`,
    );
  });

  it.each([
    ["an absolute URL", "https://evil.example/me/visits"],
    ["a protocol-relative host", "//evil.example"],
    ["a javascript URL", "javascript:alert(1)"],
    ["an encoded host", "%2F%2Fevil.example"],
    ["a backslash host", "/\\evil.example"],
    ["a screen that is not offered", "/admin/users"],
  ])("ignores %s and uses the default", (_name, hostile) => {
    renderHeader({}, from(hostile));
    expect(screen.getByRole("link", { name: "Back to encounters" })).toBeTruthy();
    expect(document.querySelector("a[href*='evil']")).toBeNull();
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
  });
});

describe("the Document / Review / Complete strip", () => {
  it("leads from the record to the composer for a draft, carrying the way back (T36)", () => {
    renderHeader({ screen: "record" }, from("/work/drafts"));
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    expect(within(strip).getByRole("link", { name: "Document" }).getAttribute("href")).toBe(
      `/patients/patient-1/encounters/enc-1/compose?from=${encodeURIComponent("/work/drafts")}`,
    );
  });

  it("shows Document unavailable, with the reason, to an account that may read the draft but not author encounters", () => {
    renderHeader({ screen: "record", canAuthor: false });
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    expect(within(strip).queryByRole("link", { name: "Document" })).toBeNull();
    const documentStep = within(strip).getByRole("button", { name: "Document" });
    expect(documentStep.getAttribute("aria-disabled")).toBe("true");
    const reason = globalThis.document.getElementById(
      documentStep.getAttribute("aria-describedby") as string,
    );
    expect(reason?.textContent).toMatch(/You can read this note but not edit it/);
  });

  it("shows Document disabled, with the reason and the exact status, once the note is not a draft", () => {
    renderHeader({ screen: "record", encounter: { ...encounter, status: "finalized" } });
    const document = screen.getByRole("button", { name: "Document" });
    expect(document.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getAttribute("aria-describedby") as string;
    expect(globalThis.document.getElementById(reason)?.textContent).toMatch(
      /this encounter is Finalized, and only a Draft can be edited/,
    );
    expect(screen.queryByRole("link", { name: "Document" })).toBeNull();
  });

  it("marks the composer's Document step as current and moves to Review and Complete within the page, without navigating", () => {
    renderHeader({ screen: "compose" });
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    const documentStep = within(strip).getByRole("link", { name: "Document" });
    expect(documentStep.getAttribute("aria-current")).toBe("step");

    const target = screen.getByLabelText("Review target");
    target.scrollIntoView = vi.fn();
    fireEvent.click(within(strip).getByRole("link", { name: "Review" }));
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBe(target);
    expect(within(strip).getByRole("link", { name: "Review" }).getAttribute("aria-current")).toBe(
      "step",
    );
    expect(documentStep.getAttribute("aria-current")).toBeNull();
    // A router navigation to the hash would meet the composer's "Leave without saving?" guard for nothing.
    expect(screen.getByLabelText("location").textContent).toBe("/x");
  });

  it("moves focus to the Complete target on the record", () => {
    renderHeader({ screen: "record" });
    const target = screen.getByLabelText("Complete target");
    target.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole("link", { name: "Complete" }));
    expect(globalThis.document.activeElement).toBe(target);
  });

  it("sends Complete from the composer of a note that is no longer a draft to the record's sign-off, because signing is there", () => {
    renderHeader(
      { screen: "compose", encounter: { ...encounter, status: "finalized" } },
      from("/me/visits"),
    );
    expect(screen.getByRole("link", { name: "Complete" }).getAttribute("href")).toBe(
      `/patients/patient-1/encounters/enc-1?from=${encodeURIComponent("/me/visits")}#visit-complete`,
    );
  });

  it.each([
    ["draft", "Draft"],
    ["finalized", "Finalized"],
    ["signed", "Signed"],
  ])("states a %s encounter as the server returned it and claims nothing else", (status, label) => {
    renderHeader({ screen: "record", encounter: { ...encounter, status } });
    const header = screen.getByRole("region", { name: "Visit context" });
    expect(within(header).getAllByText(label)).toHaveLength(1);
    for (const other of ["Saved", "Completed", "Draft", "Finalized", "Signed"].filter(
      (word) => word !== label,
    )) {
      expect(within(header).queryByText(other)).toBeNull();
    }
  });

  it("leaves Review out, with the reason, where the composer has none (a signed or void note) (R17)", () => {
    renderHeader({ screen: "compose", encounter: { ...encounter, status: "signed" } });
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    expect(within(strip).queryByRole("link", { name: "Review" })).toBeNull();
    const review = within(strip).getByRole("button", { name: "Review" });
    expect(review.getAttribute("aria-disabled")).toBe("true");
    const reason = globalThis.document.getElementById(
      review.getAttribute("aria-describedby") as string,
    );
    expect(reason?.textContent).toMatch(/this encounter is Signed/);

    fireEvent.click(review);
    expect(within(strip).getByRole("link", { name: "Document" }).getAttribute("aria-current")).toBe(
      "step",
    );
    expect(screen.getByLabelText("location").textContent).toBe("/x");
  });

  it("keeps Review a step in the composer of a draft or a finalized note", () => {
    renderHeader({ screen: "compose", encounter: { ...encounter, status: "finalized" } });
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    expect(within(strip).getByRole("link", { name: "Review" })).toBeTruthy();
  });

  it("marks no step current, and writes no history entry, when the page has no anchor to go to", () => {
    renderHeader({ screen: "compose" });
    screen.getByLabelText("Review target").removeAttribute("id");
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    const review = within(strip).getByRole("link", { name: "Review" });

    // fireEvent returns false when the click was cancelled: the browser's own hash navigation (a dead history entry) did not run.
    expect(fireEvent.click(review)).toBe(false);

    expect(review.getAttribute("aria-current")).toBeNull();
    expect(within(strip).getByRole("link", { name: "Document" }).getAttribute("aria-current")).toBe(
      "step",
    );
  });

  it.each([
    ["record", "draft", "Review"],
    ["record", "finalized", "Complete"],
    ["record", "signed", "Complete"],
    ["compose", "draft", "Document"],
    ["compose", "finalized", "Review"],
  ] as const)(
    "marks the %s step of a %s note as current before anything is clicked",
    (screenName, status, current) => {
      renderHeader({ screen: screenName, encounter: { ...encounter, status } });
      const strip = screen.getByRole("navigation", { name: "Note workflow" });
      const marked = within(strip)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "step")
        .map((link) => link.textContent);
      expect(marked).toEqual([current]);
    },
  );

  it("moves the current step on with the note's status instead of keeping the one that was jumped to", () => {
    const { withProps } = renderHeader({ screen: "compose" });
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    const target = screen.getByLabelText("Complete target");
    target.scrollIntoView = vi.fn();
    fireEvent.click(within(strip).getByRole("link", { name: "Complete" }));
    expect(within(strip).getByRole("link", { name: "Complete" }).getAttribute("aria-current")).toBe(
      "step",
    );

    withProps({ screen: "compose", encounter: { ...encounter, status: "finalized" } });
    expect(within(strip).getByRole("link", { name: "Review" }).getAttribute("aria-current")).toBe(
      "step",
    );
    expect(within(strip).getByRole("link", { name: "Complete" }).getAttribute("aria-current")).toBe(
      null,
    );
  });

  it.each([
    ["ctrl", { ctrlKey: true }],
    ["cmd", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle", { button: 1 }],
  ])(
    "leaves a %s-click on a step to the browser, so a deep link opens in a new tab",
    (_name, modifier) => {
      renderHeader({ screen: "compose" });
      const target = screen.getByLabelText("Review target");
      target.scrollIntoView = vi.fn();
      const review = screen.getByRole("link", { name: "Review" });
      // fireEvent returns true when nobody cancelled the click: the browser's own navigation runs.
      expect(fireEvent.click(review, modifier)).toBe(true);
      expect(target.scrollIntoView).not.toHaveBeenCalled();
      expect(review.getAttribute("aria-current")).toBeNull();
    },
  );

  it("has no accessibility violations", async () => {
    const { container } = renderHeader(
      { screen: "record", encounter: { ...encounter, status: "signed" } },
      from("/me/visits"),
    );
    await screen.findByText("Nora Nurse");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
