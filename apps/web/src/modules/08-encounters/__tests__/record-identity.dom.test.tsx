// Workflow 09, WP1 (scenarios T27, T28 front half, T36) — the encounter record names the patient the ENCOUNTER belongs to, never the one in the
// URL, and never keeps the previous encounter's patient on screen while the next one loads or when its patient cannot be read.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EncounterRead } from "../encounter-read";

const RECORD_PATH = "/patients/:patientId/encounters/:encounterId";

const baseEncounter = {
  organizationId: "org-1",
  admissionId: "admission-1",
  visitId: null,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status: "draft",
  lateEntryTier: "normal",
  version: 1,
  authoredByUserId: "mem-1",
  isF2f: false,
  signedAt: null,
  cosignedAt: null,
  selections: null,
  finalDocumentation: null,
  vitals: null,
  mileage: null,
  carePlanLinks: [],
};

const encounters: Record<string, Record<string, unknown>> = {
  "enc-a": { ...baseEncounter, id: "enc-a", patientId: "patient-a" },
  "enc-b": { ...baseEncounter, id: "enc-b", patientId: "patient-b" },
  "enc-final": { ...baseEncounter, id: "enc-final", patientId: "patient-a", status: "finalized" },
};

const patients: Record<string, Record<string, unknown>> = {
  "patient-a": {
    firstName: "Alma",
    lastName: "Anders",
    dob: "1950-01-01",
    mrn: "MRNA",
    status: "active",
  },
  "patient-b": {
    firstName: "Boris",
    lastName: "Baker",
    dob: "1951-02-02",
    mrn: "MRNB",
    status: "active",
  },
};

interface Options {
  /** Encounter ids whose read never settles until `release` is called. */
  readonly held?: readonly string[];
  /** Patient ids whose read fails. */
  readonly unreadablePatients?: readonly string[];
  /** Encounter ids the server refuses. */
  readonly refused?: readonly string[];
}

function fakeClient(options: Options = {}) {
  const releases: Array<() => void> = [];
  const patientReads: string[] = [];
  const get = vi.fn(async (path: string, init?: { params?: { path?: Record<string, string> } }) => {
    const params = init?.params?.path ?? {};
    if (path === "/api/v1/encounters/{encounterId}") {
      const id = params.encounterId ?? "";
      if (options.held?.includes(id)) await new Promise<void>((resolve) => releases.push(resolve));
      if (options.refused?.includes(id)) {
        return {
          error: { error: { code: "NOT_FOUND" } },
          response: new Response(null, { status: 404 }),
        };
      }
      return { data: encounters[id] };
    }
    if (path === "/api/v1/patients/{id}") {
      const id = params.id ?? "";
      patientReads.push(id);
      if (options.unreadablePatients?.includes(id)) {
        return {
          error: { error: { code: "NOT_FOUND" } },
          response: new Response(null, { status: 404 }),
        };
      }
      return { data: patients[id] };
    }
    if (path === "/api/v1/encounters/{encounterId}/cosignature") return { data: { status: null } };
    if (path === "/api/v1/internal/care-plan/relevant-elements") {
      return { data: { problems: [], goals: [], interventions: [], redacted: false } };
    }
    if (path === "/api/v1/encounters/{encounterId}/selections") {
      return { data: { sections: [], layer1Preview: "", version: 1 } };
    }
    return { data: { assessments: [] } };
  });
  const ok = vi.fn(async () => ({ data: { status: "ok" }, response: new Response() }));
  return {
    client: { GET: get, PATCH: ok, POST: ok },
    release: () => {
      for (const release of releases.splice(0)) release();
    },
    patientReads,
  };
}

function Where(): JSX.Element {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{`${pathname}${search}`}</output>;
}

function BackButton(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      go back
    </button>
  );
}

/** `earlier` are the history entries before `initialPath` (a screen the user came from), so Back has somewhere to go. */
function renderRecord(client: unknown, initialPath: string, earlier: readonly string[] = []): void {
  render(
    <MemoryRouter initialEntries={[...earlier, initialPath]} initialIndex={earlier.length}>
      <ApiClientProvider client={client as never}>
        <ToastProvider>
          <SessionProvider
            session={{
              userId: "user-1",
              organizationId: "org-1",
              permissions: ["encounter.read", "encounter.author"],
            }}
          >
            <Where />
            <Link to="/patients/patient-b/encounters/enc-b">go to B</Link>
            <BackButton />
            <Routes>
              <Route path="/me/visits" element={<output>my visits</output>} />
              <Route path={RECORD_PATH} element={<EncounterRead />} />
              <Route path={`${RECORD_PATH}/compose`} element={<output>composer</output>} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("the encounter record's identity", () => {
  it("shows the encounter's own patient and moves the URL to it when the URL names another patient (T27)", async () => {
    const { client, patientReads } = fakeClient();
    renderRecord(client, "/patients/patient-a/encounters/enc-b");

    expect(await screen.findByText("Boris Baker")).toBeTruthy();
    expect(screen.queryByText("Alma Anders")).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        "/patients/patient-b/encounters/enc-b",
      ),
    );
    // The URL's patient is never read as the encounter's.
    expect(patientReads).not.toContain("patient-a");
  });

  it("reads the encounter once when it moves the URL to the encounter's patient (audited reads are not repeated)", async () => {
    const { client } = fakeClient();
    renderRecord(client, "/patients/patient-a/encounters/enc-b");

    await screen.findByText("Boris Baker");
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        "/patients/patient-b/encounters/enc-b",
      ),
    );
    await act(async () => undefined);
    expect(
      client.GET.mock.calls.filter(([path]) => path === "/api/v1/encounters/{encounterId}"),
    ).toHaveLength(1);
  });

  it("does not pull the user to the encounter's patient when they went Back before the read returned", async () => {
    const { client, release } = fakeClient({ held: ["enc-b"] });
    renderRecord(client, "/patients/patient-a/encounters/enc-b", ["/me/visits"]);
    await act(async () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "go back" }));
    expect(screen.getByLabelText("location").textContent).toBe("/me/visits");
    await act(async () => release());

    await waitFor(() => expect(client.GET).toHaveBeenCalled());
    expect(screen.getByLabelText("location").textContent).toBe("/me/visits");
    expect(screen.queryByText("Boris Baker")).toBeNull();
  });

  it("keeps the way back when it moves the URL to the encounter's patient (T36)", async () => {
    const { client } = fakeClient();
    renderRecord(
      client,
      `/patients/patient-a/encounters/enc-b?from=${encodeURIComponent("/me/visits?status=completed")}#visit-complete`,
    );

    await screen.findByText("Boris Baker");
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/patient-b/encounters/enc-b?from=${encodeURIComponent("/me/visits?status=completed")}`,
      ),
    );
  });

  it("does not keep the previous encounter's patient on screen while the next one loads (T27)", async () => {
    const { client, release } = fakeClient({ held: ["enc-b"] });
    renderRecord(client, "/patients/patient-a/encounters/enc-a");
    expect(await screen.findByText("Alma Anders")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "go to B" }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        "/patients/patient-b/encounters/enc-b",
      ),
    );
    expect(screen.queryByText("Alma Anders")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Boris Baker")).toBeTruthy();
  });

  it("does not keep the previous patient when the next encounter's patient cannot be read (T27)", async () => {
    const { client } = fakeClient({ unreadablePatients: ["patient-b"] });
    renderRecord(client, "/patients/patient-a/encounters/enc-a");
    expect(await screen.findByText("Alma Anders")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "go to B" }));

    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        "/patients/patient-b/encounters/enc-b",
      ),
    );
    await waitFor(() => expect(screen.queryByText("Alma Anders")).toBeNull());
    expect(screen.queryByText("Boris Baker")).toBeNull();
  });

  it("names no patient when the server refuses the encounter, whatever the URL says (T28 front half)", async () => {
    const { client, patientReads } = fakeClient({ refused: ["enc-b"] });
    renderRecord(client, "/patients/patient-a/encounters/enc-b");

    expect(await screen.findByText("Could not load the encounter.")).toBeTruthy();
    expect(screen.queryByText("Alma Anders")).toBeNull();
    expect(screen.queryByText("Boris Baker")).toBeNull();
    expect(patientReads).toEqual([]);
  });
});

// Workflow 09, WP1 — the record's visit context: one patient banner that opens the chart, one way back, the Document / Review / Complete
// strip, and the two anchors Review and Complete move to.
describe("the record's visit context header", () => {
  const origin = (path: string) => `?from=${encodeURIComponent(path)}`;

  it("names the encounter and opens the chart from the patient's name (T01)", async () => {
    const { client } = fakeClient();
    renderRecord(client, "/patients/patient-a/encounters/enc-a");

    const header = await screen.findByRole("region", { name: "Visit context" });
    expect(within(header).getByText("Routine Visit")).toBeTruthy();
    expect(within(header).getByText("Draft")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Alma Anders" }).getAttribute("href")).toBe(
      "/patients/patient-a",
    );
  });

  it("has one way back, to the patient's encounters when the record was not opened from a list (T36)", async () => {
    const { client } = fakeClient();
    renderRecord(client, "/patients/patient-a/encounters/enc-a");

    await screen.findByRole("region", { name: "Visit context" });
    expect(screen.getAllByRole("link", { name: /^Back to/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Back to encounters" }).getAttribute("href")).toBe(
      "/patients/patient-a/encounters",
    );
    expect(screen.queryByRole("button", { name: "Open chart" })).toBeNull();
  });

  it("goes back to the list it was opened from, with that list's filters (T36)", async () => {
    const { client } = fakeClient();
    renderRecord(
      client,
      `/patients/patient-a/encounters/enc-a${origin("/me/visits?status=completed&page=2")}`,
    );

    const back = await screen.findByRole("link", { name: "Back to My Visits" });
    expect(back.getAttribute("href")).toBe("/me/visits?status=completed&page=2");
    expect(screen.getAllByRole("link", { name: /^Back to/ })).toHaveLength(1);
  });

  it("ignores a way back that is not one of the app's screens", async () => {
    const { client } = fakeClient();
    renderRecord(client, `/patients/patient-a/encounters/enc-a${origin("//evil.example/x")}`);

    expect(await screen.findByRole("link", { name: "Back to encounters" })).toBeTruthy();
    expect(document.querySelector("a[href*='evil']")).toBeNull();
  });

  it("opens the composer from Document and from Compose note, carrying the way back", async () => {
    const { client } = fakeClient();
    renderRecord(client, `/patients/patient-a/encounters/enc-a${origin("/work/drafts")}`);

    const strip = await screen.findByRole("navigation", { name: "Note workflow" });
    expect(within(strip).getByRole("link", { name: "Document" }).getAttribute("href")).toBe(
      `/patients/patient-a/encounters/enc-a/compose${origin("/work/drafts")}`,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Compose note" }));
    await waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        `/patients/patient-a/encounters/enc-a/compose${origin("/work/drafts")}`,
      ),
    );
  });

  it("shows Document disabled with the reason once the encounter is finalized", async () => {
    const { client } = fakeClient();
    renderRecord(client, "/patients/patient-a/encounters/enc-final");

    const strip = await screen.findByRole("navigation", { name: "Note workflow" });
    const document = within(strip).getByRole("button", { name: "Document" });
    expect(document.getAttribute("aria-disabled")).toBe("true");
    expect(within(strip).getByText(/this encounter is Finalized/)).toBeTruthy();
  });

  it("has the anchors Review and Complete move to, on the note and on the sign-off actions", async () => {
    const { client } = fakeClient();
    renderRecord(client, "/patients/patient-a/encounters/enc-a");

    await screen.findByRole("region", { name: "Visit context" });
    const review = globalThis.document.getElementById("visit-review");
    const complete = globalThis.document.getElementById("visit-complete");
    expect(
      within(review as HTMLElement).getByRole("heading", { name: "Documentation" }),
    ).toBeTruthy();
    expect(
      within(complete as HTMLElement).getByRole("heading", { name: "Quick actions" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Complete" }));
    expect(globalThis.document.activeElement).toBe(complete);
  });

  it("lands on the Complete anchor when opened at it (the composer's link to sign-off)", async () => {
    const { client } = fakeClient();
    renderRecord(client, "/patients/patient-a/encounters/enc-final#visit-complete");

    await waitFor(() => expect(globalThis.document.activeElement?.id).toBe("visit-complete"));
  });

  it("has no accessibility violations with the header, the strip and the anchors in place", async () => {
    const { client } = fakeClient();
    renderRecord(client, `/patients/patient-a/encounters/enc-a${origin("/me/visits")}`);

    await screen.findByRole("region", { name: "Visit context" });
    const results = await axe.run(globalThis.document.body, {
      // Page-level landmark rules judge the app shell this harness does not mount, not the screen under test.
      rules: { region: { enabled: false }, "landmark-main-is-top-level": { enabled: false } },
    });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it.each([
    ["enc-a", "Draft"],
    ["enc-final", "Finalized"],
  ])("states %s's status as the server returned it, in one status pill", async (id, label) => {
    const { client } = fakeClient();
    renderRecord(client, `/patients/patient-a/encounters/${id}`);

    const header = await screen.findByRole("region", { name: "Visit context" });
    expect(within(header).getAllByText(label)).toHaveLength(1);
    // A finalized note is not "Signed", and neither status is a "Saved" claim the server did not make.
    for (const other of ["Signed", "Saved", "Cosigned", "Completed"]) {
      expect(within(header).queryByText(other)).toBeNull();
    }
  });
});
