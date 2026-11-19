// @vitest-environment jsdom
// The encounter record's signed note and its addendum dialog (ADR-0114 VN-D30, S1 PR E3): the note is read section by section from
// `finalDocumentationView` (never the legacy string, which carries a generic withheld sentence), a withheld part is a labelled block, an
// amended section opens its history, and the addendum dialog offers the amending path only when the draft is on and the note has sealed
// sections. Synthetic data only.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EncounterRead } from "../encounter-read";

// A stand-in for the legacy string the API still sends: it must never reach the screen when the structured view is there.
const LEGACY_TEXT = "LEGACY STRING: must never be shown when the structured view is present.";

const signedRn = {
  id: "enc-1",
  organizationId: "org-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  visitId: "visit-1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status: "signed",
  lateEntryTier: "normal",
  version: 2,
  authoredByUserId: "mem-1",
  isF2f: false,
  signedAt: "2026-09-01T10:00:00Z",
  cosignedAt: null,
  selections: null,
  finalDocumentation: LEGACY_TEXT,
  vitals: null,
  mileage: null,
  carePlanLinks: [],
  addenda: [],
  visitModality: "telephonic",
  visitModalityConfirmed: true,
  timeSource: null,
  evvBracketPresent: true,
};

const viewSection = (sectionId: string | null, over: Record<string, unknown> = {}) => ({
  sectionId,
  text: `Signed text of ${sectionId}.`,
  withheld: false,
  amendedByAddendumId: null,
  signedAt: "2026-09-01T10:00:00Z",
  ...over,
});

const DRAFT_PATH = "/api/v1/encounters/{encounterId}/draft";
const ADDENDA_PATH = "/api/v1/encounters/{encounterId}/addenda";

let encounter: Record<string, unknown>;
let draftOn: boolean;
type PostImpl = (path: string, init?: unknown) => Promise<unknown>;
const opened: PostImpl = async () => ({ data: { id: "add-9", status: "draft" } });

beforeEach(() => {
  encounter = signedRn;
  draftOn = true;
});

function mount(postImpl: PostImpl = opened) {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
    if (path === "/api/v1/encounters/{encounterId}/cosignature") return { data: { status: null } };
    if (path === "/api/v1/patients/{id}")
      return {
        data: {
          firstName: "Ava",
          lastName: "Stone",
          dob: "1950-01-01",
          mrn: "MRN1",
          status: "active",
        },
      };
    if (path === "/api/v1/internal/care-plan/relevant-elements")
      return { data: { problems: [], goals: [], interventions: [], redacted: false } };
    if (path === DRAFT_PATH) {
      return draftOn
        ? {
            data: {
              encounterId: "enc-1",
              patientId: "patient-1",
              templateKey: "routine_visit:rn",
              asOf: "2026-08-31T23:59:59.999Z",
              sections: [],
            },
          }
        : {
            error: { error: { code: "NOT_FOUND", message: "not found" } },
            response: new Response(null, { status: 404 }),
          };
    }
    return { data: { assessments: [] } };
  });
  const post = vi.fn(postImpl);
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider client={{ GET: get, PATCH: vi.fn(), POST: post } as never}>
        <ToastProvider>
          <SessionProvider
            session={{ userId: "user-1", organizationId: "org-1", permissions: ["encounter.read"] }}
          >
            <Routes>
              <Route
                path="/patients/:patientId/encounters/:encounterId"
                element={<EncounterRead />}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { get, post };
}

const documentation = async () =>
  within(
    await screen
      .findByRole("heading", { name: "Documentation" })
      .then((h) => h.closest("section") as HTMLElement),
  );

describe("the signed note on the encounter record", () => {
  it("reads each section from the structured view, never the legacy string", async () => {
    encounter = {
      ...signedRn,
      finalDocumentationView: {
        withheld: false,
        sections: [viewSection("pain"), viewSection("plan")],
      },
    };
    mount();
    const note = await documentation();
    expect(await note.findByRole("region", { name: "Pain" })).toBeInTheDocument();
    expect(note.getByText("Signed text of plan.")).toBeInTheDocument();
    expect(screen.queryByText(LEGACY_TEXT)).toBeNull();
  });

  it("shows a withheld section as a labelled block and the rest as note text", async () => {
    encounter = {
      ...signedRn,
      finalDocumentationView: {
        withheld: false,
        sections: [viewSection("pain"), viewSection("sud_history", { text: null, withheld: true })],
      },
    };
    mount();
    const note = await documentation();
    const sud = await note.findByRole("region", { name: "Sud history" });
    expect(within(sud).getByText("Withheld")).toBeInTheDocument();
    expect(within(sud).getByText(/Protected by 42 CFR Part 2/)).toBeInTheDocument();
    expect(screen.queryByText(LEGACY_TEXT)).toBeNull();
  });

  it("shows a whole withheld note as one labelled block, not the fallback text", async () => {
    encounter = { ...signedRn, finalDocumentationView: { withheld: true, sections: [] } };
    mount();
    const note = await documentation();
    expect(await note.findByText(/does not include this note/)).toBeInTheDocument();
    expect(screen.queryByText("No assembled documentation is available.")).toBeNull();
    expect(screen.queryByText(LEGACY_TEXT)).toBeNull();
  });

  it("opens the history of an amended section from the note's history", async () => {
    const user = userEvent.setup();
    encounter = {
      ...signedRn,
      finalDocumentationView: {
        withheld: false,
        sections: [
          viewSection("pain", {
            text: "Pain, amended.",
            amendedByAddendumId: "add-1",
            signedAt: "2026-09-02T09:00:00Z",
          }),
        ],
      },
      noteHistory: {
        sections: [
          {
            sectionId: "pain",
            versions: [
              {
                kind: "original",
                addendumId: null,
                authoredByMembershipId: "mem-1",
                signedAt: "2026-09-01T10:00:00Z",
                text: "Pain, as first signed.",
                withheld: false,
                current: false,
              },
              {
                kind: "amendment",
                addendumId: "add-1",
                authoredByMembershipId: "mem-2",
                signedAt: "2026-09-02T09:00:00Z",
                text: "Pain, amended.",
                withheld: false,
                current: true,
              },
            ],
          },
        ],
      },
    };
    mount();
    const note = await documentation();
    const pain = await note.findByRole("region", { name: "Pain" });
    expect(within(pain).getByText("Amended")).toBeInTheDocument();
    await user.click(within(pain).getByText("Version history (2 versions)"));
    expect(within(pain).getByText("Pain, as first signed.")).toBeInTheDocument();
    expect(within(pain).getByText("Current")).toBeInTheDocument();
  });

  it("falls back to the legacy text only when the API sent no structured view", async () => {
    mount();
    const note = await documentation();
    expect(await note.findByText(LEGACY_TEXT)).toBeInTheDocument();
  });
});

describe("the addendum dialog", () => {
  const sealed = () => ({
    ...signedRn,
    finalDocumentationView: {
      withheld: false,
      sections: [
        viewSection("pain"),
        viewSection("plan"),
        viewSection("sud_history", { text: null, withheld: true }),
      ],
    },
  });
  const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "Add addendum" }));
    return within(await screen.findByRole("dialog", { name: "Encounter action" }));
  };

  it("offers the sealed sections to amend when the draft is on, and sends the ones chosen", async () => {
    const user = userEvent.setup();
    encounter = sealed();
    const { post } = mount();
    const dialog = await openDialog(user);
    await dialog.findByRole("checkbox", { name: "Plan" });
    expect(dialog.getByRole("checkbox", { name: /Sud history/ })).toBeDisabled();
    await user.click(dialog.getByRole("checkbox", { name: "Plan" }));
    await user.click(dialog.getByRole("checkbox", { name: "Pain" }));
    await user.type(
      dialog.getByRole("textbox", { name: "Reason" }),
      "The plan changed after the family call.",
    );
    await user.click(dialog.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(ADDENDA_PATH, {
      params: { path: { encounterId: "enc-1" } },
      body: {
        reason: "The plan changed after the family call.",
        amendsSectionIds: ["plan", "pain"],
      },
    });
    expect(await screen.findByText(/Review the redrafted sections/)).toBeInTheDocument();
  });

  it("is the free addendum, exactly as before, with none chosen", async () => {
    const user = userEvent.setup();
    encounter = sealed();
    const { post } = mount();
    const dialog = await openDialog(user);
    await user.type(
      dialog.getByRole("textbox", { name: "Reason" }),
      "A late report from the family.",
    );
    await user.click(dialog.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(ADDENDA_PATH, {
      params: { path: { encounterId: "enc-1" } },
      body: { reason: "A late report from the family." },
    });
  });

  it("starts with nothing chosen each time it is opened", async () => {
    const user = userEvent.setup();
    encounter = sealed();
    mount();
    let dialog = await openDialog(user);
    await user.click(await dialog.findByRole("checkbox", { name: "Plan" }));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    dialog = await openDialog(user);
    expect(await dialog.findByRole("checkbox", { name: "Plan" })).not.toBeChecked();
  });

  it("offers no amending when the draft is off", async () => {
    const user = userEvent.setup();
    encounter = sealed();
    draftOn = false;
    mount();
    const dialog = await openDialog(user);
    expect(dialog.getByRole("textbox", { name: "Reason" })).toBeInTheDocument();
    expect(dialog.queryByRole("group", { name: /Amend sections/ })).toBeNull();
  });

  it("offers no amending for a pin with no sealed sections", async () => {
    const user = userEvent.setup();
    encounter = {
      ...signedRn,
      finalDocumentationView: { withheld: false, sections: [viewSection(null)] },
    };
    mount();
    const dialog = await openDialog(user);
    expect(dialog.queryByRole("group", { name: /Amend sections/ })).toBeNull();
  });

  it("offers no amending when there is no structured view", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openDialog(user);
    expect(dialog.queryByRole("group", { name: /Amend sections/ })).toBeNull();
  });

  it("says, with the free addendum as the next step, that amending is unavailable when the API answers 404", async () => {
    const user = userEvent.setup();
    encounter = sealed();
    mount(async () => ({
      error: { error: { code: "NOT_FOUND", message: "not found" } },
      response: new Response(null, { status: 404 }),
    }));
    const dialog = await openDialog(user);
    await user.click(await dialog.findByRole("checkbox", { name: "Plan" }));
    await user.type(
      dialog.getByRole("textbox", { name: "Reason" }),
      "The plan changed after the call.",
    );
    await user.click(dialog.getByRole("button", { name: "Confirm" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(/switched off.*free addendum/s);
  });

  it("says a chosen section is not part of the signed note when the API answers 422 UNKNOWN_TEMPLATE_SECTION", async () => {
    const user = userEvent.setup();
    encounter = sealed();
    mount(async () => ({
      error: { error: { code: "UNKNOWN_TEMPLATE_SECTION", message: "no such section" } },
      response: new Response(null, { status: 422 }),
    }));
    const dialog = await openDialog(user);
    await user.click(await dialog.findByRole("checkbox", { name: "Plan" }));
    await user.type(
      dialog.getByRole("textbox", { name: "Reason" }),
      "The plan changed after the call.",
    );
    await user.click(dialog.getByRole("button", { name: "Confirm" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(/not part of the signed note/);
  });
});
