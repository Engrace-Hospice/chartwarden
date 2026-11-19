// @vitest-environment jsdom
// The sign step with a drafted note (ADR-0114 VN-D7): the signer is told, beside the Sign button, which drafted sections still need them
// and where to resolve them; the button waits; and when the server refuses the sign with 409 DRAFT_SECTION_STALE the sections it names are
// shown in words and the draft is re-read. A note with nothing drafted, or a tenant with the draft off, signs exactly as before.
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
});

function mount(postImpl: PostImpl = signed) {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/encounters/{encounterId}") return { data: finalizedRn };
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
              permissions: ["encounter.author", "encounter.finalize", "encounter.sign"],
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
    const button = await signButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/still needs your review/);
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
