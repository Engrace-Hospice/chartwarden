// @vitest-environment jsdom
// The sign step with a drafted note (ADR-0114 VN-D7): the signer is told, beside the Sign button, which drafted sections still need them
// and where to resolve them; the button waits; and when the server refuses the sign with 409 DRAFT_SECTION_STALE the sections it names are
// shown in words and the draft is re-read. A note with nothing drafted, or a tenant with the draft off, signs exactly as before.
// E1 (the per-viewer Part 2 view): a note finalized with Part 2 draft text cannot be signed once the draft is switched off (409
// DRAFT_OFF_AFTER_FINALIZE, with the next step), and a note view whose Part 2 check cannot be decided (503 NOTE_VIEW_UNAVAILABLE) is an
// error state with a retry, never an empty or partial note.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EncounterRead } from "../encounter-read";

const finalizedRn = {
  id: "enc-1",
  organizationId: "org-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  visitId: "visit-1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status: "finalized",
  lateEntryTier: "normal",
  version: 1,
  authoredByUserId: "mem-1",
  isF2f: false,
  signedAt: null,
  cosignedAt: null,
  selections: { narrative: { clinicalSummary: "Initial note" } },
  finalDocumentation: null,
  vitals: null,
  mileage: null,
  carePlanLinks: [],
  visitModality: "telephonic",
  visitModalityConfirmed: true,
  timeSource: null,
  evvBracketPresent: true,
};

const DRAFT_PATH = "/api/v1/encounters/{encounterId}/draft";
const SIGN_PATH = "/api/v1/encounters/{encounterId}/sign";

const section = (sectionId: string, state: string) => ({
  sectionId,
  state,
  text: state === "not_drafted" ? null : "Drafted sentence.",
  contentHash: state === "not_drafted" ? null : `hash-${sectionId}`,
  corpusVersion: state === "not_drafted" ? null : "2026.1.0",
  part2Derived: state === "not_drafted" ? null : false,
  origins: state === "not_drafted" ? [] : ["vitals"],
});

let sections: ReturnType<typeof section>[];
let draftAnswer: "ok" | "off";
/** How many reads of the encounter answer 503 NOTE_VIEW_UNAVAILABLE before it answers. */
let noteViewFailures: number;
/** The status and code the encounter read answers instead, when set (a failure that is not a retryable note view). */
let encounterFailure: { status: number; code: string } | null;
type PostImpl = (path: string, init?: unknown) => Promise<unknown>;

const signed: PostImpl = async () => ({ data: { status: "signed" }, response: new Response() });
const refused =
  (status: number, code: string, details: unknown[] = []): PostImpl =>
  async () => ({
    error: { error: { code, message: "refused", details } },
    response: new Response(null, { status }),
  });

beforeEach(() => {
  sections = [section("vitals_review", "unresolved"), section("plan", "confirmed")];
  draftAnswer = "ok";
  noteViewFailures = 0;
  encounterFailure = null;
});

function mount(
  postImpl: PostImpl = signed,
  permissions: string[] = ["encounter.author", "encounter.finalize", "encounter.sign"],
) {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/encounters/{encounterId}") {
      if (noteViewFailures > 0) {
        noteViewFailures -= 1;
        return {
          error: { error: { code: "NOTE_VIEW_UNAVAILABLE", message: "cannot be decided" } },
          response: new Response(null, { status: 503 }),
        };
      }
      if (encounterFailure !== null)
        return {
          error: { error: { code: encounterFailure.code, message: "failed" } },
          response: new Response(null, { status: encounterFailure.status }),
        };
      return { data: finalizedRn };
    }
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
      return draftAnswer === "off"
        ? {
            error: { error: { code: "NOT_FOUND", message: "not found" } },
            response: new Response(null, { status: 404 }),
          }
        : {
            data: {
              encounterId: "enc-1",
              patientId: "patient-1",
              templateKey: "routine_visit:rn",
              asOf: "2026-08-31T23:59:59.999Z",
              sections,
            },
          };
    }
    return { data: { assessments: [] } };
  });
  const post = vi.fn(postImpl);
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider
        client={{ GET: get, PATCH: vi.fn(async () => ({ data: {} })), POST: post } as never}
      >
        <ToastProvider>
          <SessionProvider
            session={{
              userId: "user-1",
              organizationId: "org-1",
              permissions,
            }}
          >
            <Routes>
              <Route
                path="/patients/:patientId/encounters/:encounterId"
                element={<EncounterRead />}
              />
              <Route
                path="/patients/:patientId/encounters/:encounterId/compose"
                element={<h1>Composer</h1>}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, get };
}

const signButton = () => screen.findByRole("button", { name: "Sign encounter" });
const draftReads = (get: ReturnType<typeof mount>["get"]) =>
  get.mock.calls.filter(([path]) => path === DRAFT_PATH).length;

// The page repeats a failed action's message behind the ceremony, so the ceremony's own alert is found inside it.
const ceremonyAlert = () =>
  waitFor(() => within(screen.getByRole("dialog", { name: "Sign encounter" })).getByRole("alert"));

async function signThroughTheCeremony(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await signButton());
  await user.click(await screen.findByRole("checkbox", { name: /complete and accurate/i }));
  await user.click(screen.getByRole("button", { name: /sign & commit/i }));
}

describe("an unresolved drafted section, for an account that may not author encounters", () => {
  it("is named with the reason it cannot be resolved here, and no link to the composer it would be refused", async () => {
    mount(signed, ["encounter.read", "encounter.sign"]);
    const notice = await screen.findByRole("region", { name: "Drafted sections" });
    expect(within(notice).getByText(/Vitals review/)).toBeInTheDocument();
    expect(within(notice).getByText(/You can read this note but not edit it/)).toBeInTheDocument();
    expect(within(notice).queryByRole("link")).toBeNull();
    expect(document.querySelector('a[href*="/compose"]')).toBeNull();
  });
});

describe("an unresolved drafted section", () => {
  it("is named beside a Sign button that waits, with the way to resolve it", async () => {
    mount();
    const notice = await screen.findByRole("region", { name: "Drafted sections" });
    expect(
      within(notice).getByText(
        "1 drafted section still needs your review before this note can be signed.",
      ),
    ).toBeInTheDocument();
    expect(within(notice).getByText("Vitals review")).toBeInTheDocument();
    expect(within(notice).getByText("Needs your review")).toBeInTheDocument();
    expect(
      within(notice).getByRole("link", { name: "Review them in the note editor" }),
    ).toHaveAttribute("href", "/patients/patient-1/encounters/enc-1/compose");
    // The status text above the button no longer claims the note is ready.
    expect(screen.getByText("Review before signing")).toBeInTheDocument();
    expect(screen.queryByText("Ready for signature")).toBeNull();
    // The Sign button waits but stays reachable by keyboard, tied to the reason, and opens nothing when pressed.
    const button = await signButton();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(/still needs your review/);
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.setup().click(button);
    expect(screen.queryByRole("dialog", { name: "Sign encounter" })).toBeNull();
  });

  it("names several, each with why, and counts them", async () => {
    sections = [
      section("vitals_review", "needs_reconfirmation"),
      section("plan", "unresolved"),
      section("interventions", "confirmed"),
    ];
    mount();
    const notice = await screen.findByRole("region", { name: "Drafted sections" });
    expect(
      within(notice).getByText(/2 drafted sections still need your review/),
    ).toBeInTheDocument();
    expect(within(notice).getByText("Changed, review again")).toBeInTheDocument();
    expect(within(notice).queryByText("Interventions")).toBeNull();
  });

  it("follows the link to the composer", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("link", { name: "Review them in the note editor" }));
    expect(await screen.findByRole("heading", { name: "Composer" })).toBeInTheDocument();
  });
});

describe("nothing between the signer and the Sign button", () => {
  it("shows no notice and an enabled button when every drafted section is resolved", async () => {
    sections = [
      section("vitals_review", "confirmed"),
      section("plan", "deselected"),
      section("assessment", "not_drafted"),
    ];
    mount();
    expect(await signButton()).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Drafted sections" })).toBeNull();
  });

  it("signs as before when the tenant has the draft switched off", async () => {
    draftAnswer = "off";
    const user = userEvent.setup();
    const { post } = mount();
    expect(await signButton()).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Drafted sections" })).toBeNull();
    await signThroughTheCeremony(user);
    await waitFor(() => expect(post.mock.calls.filter(([p]) => p === SIGN_PATH)).toHaveLength(1));
  });

  it("signs as before when nothing was drafted", async () => {
    sections = [section("vitals_review", "not_drafted"), section("plan", "not_drafted")];
    mount();
    expect(await signButton()).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Drafted sections" })).toBeNull();
  });
});

describe("the server refuses the sign for drafted sections", () => {
  it("names the sections in words, re-reads the draft and blocks the button behind it", async () => {
    sections = [section("vitals_review", "confirmed"), section("plan", "confirmed")];
    const user = userEvent.setup();
    const { get } = mount(
      refused(409, "DRAFT_SECTION_STALE", [
        { field: "plan", code: "DRAFT_SECTION_STALE", message: "changed" },
        { field: "vitals_review", code: "DRAFT_SECTION_UNRESOLVED", message: "never confirmed" },
      ]),
    );
    expect(await signButton()).toBeEnabled();
    const reads = draftReads(get);
    // The refusal arrives after the sources moved: the draft the server now computes differs.
    sections = [section("vitals_review", "unresolved"), section("plan", "needs_reconfirmation")];

    await signThroughTheCeremony(user);

    const alert = await ceremonyAlert();
    expect(alert).toHaveTextContent(
      /Some drafted sections need another look before this note can be signed/,
    );
    expect(alert).toHaveTextContent("Plan (changed since you resolved it)");
    expect(alert).toHaveTextContent("Vitals review (not confirmed or deselected yet)");
    await waitFor(() => expect(draftReads(get)).toBeGreaterThan(reads));
    expect(await screen.findByRole("region", { name: "Drafted sections" })).toBeInTheDocument();
  });

  it("says plainly when the draft could not be checked", async () => {
    const user = userEvent.setup();
    mount(refused(503, "COMPLIANCE_GATE_UNAVAILABLE"));
    sections = [section("vitals_review", "confirmed")];
    await signThroughTheCeremony(user);
    expect(await ceremonyAlert()).toHaveTextContent(
      "The visit-note draft could not be checked right now. Try again in a moment.",
    );
  });
});

describe("the server refuses the sign because the draft was switched off after finalize", () => {
  it("says why, that nothing changed, and the next step, and leaves the draft strip alone", async () => {
    draftAnswer = "off";
    const user = userEvent.setup();
    const { get } = mount(
      refused(409, "DRAFT_OFF_AFTER_FINALIZE", [{ message: "switch the draft back on" }]),
    );
    expect(await signButton()).toBeEnabled();
    const reads = draftReads(get);

    await signThroughTheCeremony(user);

    const alert = await ceremonyAlert();
    expect(alert).toHaveTextContent(/finalized with drafted text/);
    expect(alert).toHaveTextContent(/still finalized/);
    expect(alert).toHaveTextContent(/Ask an administrator to switch the visit-note draft back on/);
    expect(alert).toHaveTextContent(/Visit-note Draft/);
    expect(alert).toHaveTextContent(/then sign again/);
    // Not read as a stale section, a permission or a general failure.
    expect(alert).not.toHaveTextContent(/need another look/);
    expect(alert).not.toHaveTextContent(/permission/);
    expect(alert).not.toHaveTextContent(/could not be completed/);
    expect(draftReads(get)).toBe(reads);
  });

  it("moves focus to the message, so a keyboard user hears it", async () => {
    draftAnswer = "off";
    const user = userEvent.setup();
    mount(refused(409, "DRAFT_OFF_AFTER_FINALIZE"));
    await signThroughTheCeremony(user);
    const alert = await ceremonyAlert();
    await waitFor(() => expect(alert).toHaveFocus());
  });
});

describe("the note view when the Part 2 check cannot be decided", () => {
  const unavailableState = () => screen.findByRole("alert");

  it("is an error state with a retry, not an empty or partial note", async () => {
    noteViewFailures = 1;
    mount();
    const state = await unavailableState();
    expect(state).toHaveTextContent("The note cannot be shown right now");
    expect(state).toHaveTextContent(/could not be checked/);
    expect(within(state).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Nothing of the note, and none of the page's own empty or not-found wording.
    expect(screen.queryByText("No assembled documentation is available.")).toBeNull();
    expect(screen.queryByText("Not found.")).toBeNull();
    expect(screen.queryByText("Could not load the encounter.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign encounter" })).toBeNull();
  });

  it("reads the note again on retry and shows it", async () => {
    noteViewFailures = 1;
    const user = userEvent.setup();
    const { get } = mount();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await signButton()).toBeEnabled();
    expect(screen.queryByText("The note cannot be shown right now")).toBeNull();
    expect(
      get.mock.calls.filter(([path]) => path === "/api/v1/encounters/{encounterId}"),
    ).toHaveLength(2);
  });

  it("stays an error state, still retryable, when the check fails again", async () => {
    noteViewFailures = 2;
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    const state = await unavailableState();
    expect(state).toHaveTextContent("The note cannot be shown right now");
    expect(within(state).getByRole("button", { name: "Try again" })).toBeEnabled();
    await user.click(within(state).getByRole("button", { name: "Try again" }));
    expect(await signButton()).toBeEnabled();
  });

  it("leaves any other failed read as it was: unavailable, no retry offered", async () => {
    encounterFailure = { status: 500, code: "INTERNAL" };
    mount();
    expect(await screen.findByText("Could not load the encounter.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText("The note cannot be shown right now")).toBeNull();
  });
});
