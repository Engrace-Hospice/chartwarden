import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the Aide Plan of Care's patient header and staff pickers.
//   • the editor wears the same chart shell as every sibling M15 screen (patient banner + Patient Summary rail),
//     in its loading / error / empty states as well as the populated one;
//   • the Assignment panel and the supervisory ledger name the aide and supervising RN (from the plan-scoped
//     roster), say "Not assigned" when the plan binds nobody, and fall back to the short id when the roster
//     has not loaded or does not list the member;
//   • the supervisory-visit modal picks the aide and the RN from dropdowns of real staff — never free-text
//     membership ids — and, when the roster cannot be loaded, shows why and keeps "Record attestation" disabled.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AidePocEditor } from "../aide-poc-editor";
import { AidePocView } from "../aide-poc-view";

const PATIENT = "patient-1";
const PLAN = "plan-1";
const VERSION = "v-aide-draft";
const AIDE = "aaaaaaaa-0000-4000-8000-000000000001";
const AIDE_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const RN = "bbbbbbbb-0000-4000-8000-000000000001";
const RN_2 = "bbbbbbbb-0000-4000-8000-000000000002";
const ABSENT = "dddddddd-0000-4000-8000-000000000009";
const NARRATIVE =
  "Observed the aide bathing the patient; technique and infection control were sound.";

const ROSTER = {
  aides: [
    { membershipId: AIDE, displayName: "Avery Aide", roleKey: "chha" },
    { membershipId: AIDE_2, displayName: "Blake Aide", roleKey: "chha" },
  ],
  supervisors: [
    { membershipId: RN, displayName: "Riley Nurse", roleKey: "rn" },
    { membershipId: RN_2, displayName: "Casey Manager", roleKey: "rn_case_manager" },
  ],
};

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.read", "discipline_plan.author"],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const fail = (status: number, title: string) => ({
  data: undefined,
  error: { status, title },
  response: new Response(null, { status }),
});

const draft = {
  versionId: VERSION,
  planId: PLAN,
  sequence: 1,
  status: "draft",
  kind: "initial",
  idgMeetingId: null,
  finalizedAt: null,
  signedAt: null,
  supersededAt: null,
  version: 1,
};

const planDetail = (binding: { aide: string | null; rn: string | null }) => ({
  planId: PLAN,
  patientId: PATIENT,
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  locationId: "loc-1",
  kind: "aide_poc",
  status: "active",
  nextSupervisoryDueAt: null,
  initialAssessmentClockStartedAt: "2026-01-01T00:00:00.000Z",
  initialAssessmentSignedAt: null,
  spiritualCareDeclinedAt: null,
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 4,
  actionSummary: {
    openVersion: { versionId: VERSION, sequence: 1, status: "draft", kind: "initial" },
    latestSignedVersion: null,
    missingSignerRoles: [],
    ownerMembershipIds: [],
    idgDecisionId: null,
  },
  aideMembershipId: binding.aide,
  supervisingRnMembershipId: binding.rn,
  supervisoryCadenceDaysOverride: null,
  spiritualCareDeclined: null,
  goals: [],
  interventions: [],
  assessments: [],
  supervisoryVisits: [],
  volunteerAssignments: [],
  versions: [draft],
  supervisoryCadence: null,
  redacted_categories: [],
});

interface Scenario {
  readonly binding?: { aide: string | null; rn: string | null };
  /** What GET .../aide-supervision-roster answers (default: ROSTER). */
  readonly roster?: ReturnType<typeof ok> | ReturnType<typeof fail>;
  /** What the plan worklist answers (default: the plan). `null` = no aide plan yet. */
  readonly planList?: "none" | "error";
}

function makeClient(scenario: Scenario) {
  const detail = planDetail(scenario.binding ?? { aide: null, rn: null });
  const post = vi.fn(async (_path: string, _init: unknown) => ok({}));
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/discipline-plans") {
      if (scenario.planList === "error") return fail(500, "worklist exploded");
      return ok({ data: scenario.planList === "none" ? [] : [detail], next_cursor: null });
    }
    if (path === "/api/v1/discipline-plans/{planId}") return ok(detail);
    if (path === "/api/v1/discipline-plans/{planId}/aide-supervision-roster")
      return scenario.roster ?? ok(ROSTER);
    if (path === "/api/v1/patients/{id}")
      return ok({
        id: PATIENT,
        organizationId: "org-1",
        mrn: "MRN-0007",
        firstName: "June",
        lastName: "Rivera",
        dob: "1950-02-14",
        status: "active",
      });
    return ok({});
  });
  return { get, post, client: { GET: get, POST: post } as unknown as ApiClient };
}

function renderAt(scenario: Scenario, route: "editor" | "view") {
  const { client, get, post } = makeClient(scenario);
  const editorPath = "/patients/:patientId/discipline-plans/aide-poc/:versionId/edit";
  const viewPath = "/patients/:patientId/discipline-plans/aide-poc";
  render(
    <MemoryRouter
      initialEntries={[
        route === "editor"
          ? `/patients/${PATIENT}/discipline-plans/aide-poc/${VERSION}/edit`
          : `/patients/${PATIENT}/discipline-plans/aide-poc`,
      ]}
    >
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <Routes>
              <Route
                path={route === "editor" ? editorPath : viewPath}
                element={route === "editor" ? <AidePocEditor /> : <AidePocView />}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { get, post };
}

afterEach(cleanup);

const rosterReads = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter(
    (c) => c[0] === "/api/v1/discipline-plans/{planId}/aide-supervision-roster",
  );

describe("Aide POC editor — chart shell", () => {
  it("shows the patient banner and the Patient Summary rail like every other chart tab", async () => {
    renderAt({}, "editor");
    expect(await screen.findByRole("link", { name: "June Rivera" })).toBeTruthy();
    expect(screen.getByText("Patient Summary")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: /Aide Plan of Care — editor/ })).toBeTruthy();
  });

  it("keeps the patient banner when the plan cannot be loaded", async () => {
    renderAt({ planList: "error" }, "editor");
    expect(await screen.findByText("worklist exploded")).toBeTruthy();
    expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy();
  });

  it("keeps the patient banner when the patient has no Aide Plan of Care yet", async () => {
    renderAt({ planList: "none" }, "editor");
    expect(await screen.findByText("No Aide Plan of Care yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "June Rivera" })).toBeTruthy();
  });
});

describe("Aide POC — names instead of ids", () => {
  it("names the bound aide and supervising RN in the editor's Assignment panel", async () => {
    const { get } = renderAt({ binding: { aide: AIDE, rn: RN } }, "editor");
    expect(await screen.findByText("Avery Aide")).toBeTruthy();
    expect(screen.getByText("Riley Nurse")).toBeTruthy();
    await waitFor(() => expect(rosterReads(get)).toHaveLength(1));
  });

  it("says 'Not assigned' when the plan binds nobody", async () => {
    renderAt({ binding: { aide: null, rn: null } }, "editor");
    expect(await screen.findAllByText("Not assigned")).toHaveLength(2);
  });

  it("falls back to the short id for a member the roster does not list", async () => {
    renderAt({ binding: { aide: ABSENT, rn: RN } }, "editor");
    expect(await screen.findByText("Riley Nurse")).toBeTruthy();
    expect(screen.getByText("dddddddd")).toBeTruthy();
  });

  it("falls back to the short id when the roster cannot be loaded", async () => {
    renderAt({ binding: { aide: AIDE, rn: RN }, roster: fail(500, "roster down") }, "editor");
    expect(await screen.findByText("aaaaaaaa")).toBeTruthy();
    expect(screen.getByText("bbbbbbbb")).toBeTruthy();
  });

  it("names them in the supervisory ledger too, from one roster read", async () => {
    const { get } = renderAt({ binding: { aide: AIDE, rn: RN } }, "view");
    const ledger = await screen.findByRole("heading", { name: "RN supervisory attestations" });
    const panel = ledger.closest("section") as HTMLElement;
    expect(await within(panel).findByText("Avery Aide")).toBeTruthy();
    expect(within(panel).getByText("Riley Nurse")).toBeTruthy();
    expect(rosterReads(get)).toHaveLength(1);
  });
});

async function openModal(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Record supervisory visit" }));
  return screen.findByRole("dialog", { name: "Record supervisory visit" });
}

const pick = (dialog: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(dialog).getByRole("combobox", { name: label }), { target: { value } });

describe("Supervisory-visit modal — staff pickers", () => {
  it("offers the aides and RN supervisors from the roster and submits the chosen membership ids", async () => {
    const { post } = renderAt({}, "view");
    const dialog = await openModal();

    // Real people in native dropdowns, not free-text membership ids.
    await waitFor(() =>
      expect(
        Array.from(
          (within(dialog).getByRole("combobox", { name: "Aide" }) as HTMLSelectElement).options,
        ).map((o) => o.textContent),
      ).toEqual(["Select an aide", "Avery Aide", "Blake Aide"]),
    );
    expect(
      Array.from(
        (within(dialog).getByRole("combobox", { name: "Supervising RN" }) as HTMLSelectElement)
          .options,
      ).map((o) => o.textContent),
    ).toEqual(["Select a supervising RN", "Riley Nurse", "Casey Manager"]);
    expect(within(dialog).queryByRole("textbox", { name: /membership id/i })).toBeNull();

    pick(dialog, "Aide", AIDE_2);
    pick(dialog, "Supervising RN", RN_2);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Supervisory narrative/ }), {
      target: { value: NARRATIVE },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record attestation" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(path).toBe("/api/v1/discipline-plans/{planId}/aide-supervisory-visits");
    expect(init.body).toMatchObject({
      aideMembershipId: AIDE_2,
      supervisingRnMembershipId: RN_2,
      supervisoryNarrative: NARRATIVE,
    });
  });

  it("preselects the aide and RN the plan already binds", async () => {
    renderAt({ binding: { aide: AIDE, rn: RN } }, "view");
    const dialog = await openModal();
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("combobox", { name: "Aide" }) as HTMLSelectElement).value,
      ).toBe(AIDE),
    );
    expect(
      (within(dialog).getByRole("combobox", { name: "Supervising RN" }) as HTMLSelectElement).value,
    ).toBe(RN);
  });

  it("keeps a bound member the roster does not list selectable, labelled by short id", async () => {
    renderAt({ binding: { aide: ABSENT, rn: RN } }, "view");
    const dialog = await openModal();
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("combobox", { name: "Aide" }) as HTMLSelectElement).value,
      ).toBe(ABSENT),
    );
    const labels = Array.from(
      (within(dialog).getByRole("combobox", { name: "Aide" }) as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(labels).toContain("dddddddd");
  });

  it("disables Record attestation and shows why when the roster cannot be loaded", async () => {
    renderAt({ binding: { aide: AIDE, rn: RN }, roster: fail(500, "roster down") }, "view");
    const dialog = await openModal();
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByText(/roster down/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Supervisory narrative/ }), {
      target: { value: NARRATIVE },
    });
    expect(
      (within(dialog).getByRole("button", { name: "Record attestation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // No fallback to free-text ids.
    expect(within(dialog).queryByRole("textbox", { name: /membership id/i })).toBeNull();
  });
});
