// WF09 WP3 — the encounter record with the blocker panel mounted beside Finalize and Sign, through the real route. T07 (a refused
// finalize lists the server's failures, focus lands on the first, the remedy goes where it is fixed), T10 (finalized is not signed),
// T13 (no ready wording before the server answers), T33 (what nothing checks is never shown as checked), a 503 in fixed words, the
// late-entry reason on the finalize body, and a refused sign ("The note was not signed."). Synthetic data only.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ComponentProps } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../../shell/session";
import { EncounterRead } from "../../encounter-read";

// The real panel, counted: each render that gets past the memo's props check is one count.
const panelRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../blocker-panel", async (importOriginal) => {
  const original = await importOriginal<typeof import("../blocker-panel")>();
  const { memo } = await import("react");
  const Counted = memo(function Counted(props: ComponentProps<typeof original.BlockerPanel>) {
    panelRenders.count += 1;
    return <original.BlockerPanel {...props} />;
  });
  return { ...original, BlockerPanel: Counted };
});

const FINALIZE_PATH = "/api/v1/encounters/{encounterId}/finalize";
const SIGN_PATH = "/api/v1/encounters/{encounterId}/sign";
const FORTY = "The visit was documented late because the chart was unavailable.";

const baseEncounter = {
  id: "enc-1",
  organizationId: "org-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  visitId: "visit-1",
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

let status: string;
/** Make the encounter read fail as a dropped connection does (set by a write that "moved the note on"). */
let encounterReadFails: boolean;

const AUTHOR_PERMISSIONS = ["encounter.author", "encounter.finalize", "encounter.sign"];

type PostImpl = (path: string, init?: unknown) => Promise<unknown>;

const refused =
  (httpStatus: number, code: string, details: unknown[] = [], message = "refused"): PostImpl =>
  async () => ({
    error: { error: { code, message, details } },
    response: new Response(null, { status: httpStatus }),
  });

const accepted =
  (next: string): PostImpl =>
  async () => {
    status = next;
    return { data: { status: next }, response: new Response() };
  };

function Where() {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{`${pathname}${search}`}</output>;
}

function mount(
  postImpl: PostImpl,
  entry = "/patients/patient-1/encounters/enc-1",
  permissions: string[] = AUTHOR_PERMISSIONS,
) {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/encounters/{encounterId}") {
      if (encounterReadFails) throw new TypeError("offline");
      return { data: { ...baseEncounter, status } };
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
    if (path === "/api/v1/encounters/{encounterId}/draft")
      return {
        error: { error: { code: "NOT_FOUND", message: "not found" } },
        response: new Response(null, { status: 404 }),
      };
    return { data: { assessments: [] } };
  });
  const post = vi.fn(postImpl);
  render(
    <MemoryRouter initialEntries={[entry]}>
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
                element={
                  <>
                    <EncounterRead />
                    <Where />
                  </>
                }
              />
              <Route path="*" element={<Where />} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { get, post };
}

const panel = (): HTMLElement => screen.getByRole("region", { name: "Finalize and sign checks" });
const findPanel = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "Finalize and sign checks" });
const firstBlocker = (): HTMLElement | undefined =>
  within(panel())
    .getAllByRole("listitem")
    .find((row) => row.dataset.blocker !== undefined);
const callsTo = (post: ReturnType<typeof mount>["post"], path: string) =>
  post.mock.calls.filter(([called]) => called === path);

beforeEach(() => {
  status = "draft";
  encounterReadFails = false;
  panelRenders.count = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the record before the server has answered (T13, T33)", () => {
  it("says not checked yet beside Finalize, with the anchors where WP1 put them, each once", async () => {
    mount(accepted("finalized"));
    await findPanel();
    expect(within(panel()).getByText("Not checked yet")).toBeInTheDocument();
    expect(document.querySelectorAll('[id="visit-complete"]')).toHaveLength(1);
    expect(document.querySelectorAll('[id="visit-review"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Finalize note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review & finalize" })).toBeNull();
  });

  it("makes no readiness claim about a draft, and says the server checks when you finalize", async () => {
    mount(accepted("finalized"));
    await findPanel();
    expect(
      screen.getByText(
        /Complete the visit documentation, then finalize\. The server checks the note when you finalize\./,
      ),
    ).toBeInTheDocument();
    expect(panel().textContent ?? "").not.toMatch(/✓|\bready\b|\bpassed\b|\bcomplete\b/i);
  });

  it("lists what nothing checks without a button among it", async () => {
    mount(accepted("finalized"));
    await findPanel();
    const unchecked = within(panel()).getByRole("list", { name: "Not checked by ChartWarden" });
    expect(
      within(unchecked).getByText(/server does not record this acknowledgment/),
    ).toBeInTheDocument();
    expect(within(unchecked).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("a refused finalize (T07)", () => {
  const FAILURES = [
    { field: "assessment", code: "MISSING_SECTION", message: "m" },
    { field: "pps", code: "MISSING_SCALE", message: "m" },
  ];

  async function finalizeRefused(user: ReturnType<typeof userEvent.setup>) {
    const view = mount(refused(422, "COMPLIANCE_GATE_FAILED", FAILURES));
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await within(panel()).findByText("Blocked: 2 items to fix");
    return view;
  }

  it("lists each failure, says nothing was frozen, and moves focus to the first blocker", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    expect(within(panel()).getByText("Assessment has no entry")).toBeInTheDocument();
    expect(within(panel()).getByText("PPS is not on file")).toBeInTheDocument();
    expect(within(panel()).getByText(/Nothing was frozen or signed/)).toBeInTheDocument();
    await waitFor(() => expect(firstBlocker()).toHaveFocus());
  });

  it("does not repeat the gate's refusal in a page banner", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    expect(screen.queryByText(/The encounter action could not be completed/)).toBeNull();
    expect(screen.queryByText("refused")).toBeNull();
  });

  it("takes the author to the composer for a section, and to the assessments for a scale", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    await user.click(within(panel()).getByRole("button", { name: "Open assessments" }));
    expect((await screen.findByLabelText("location")).textContent).toBe(
      "/patients/patient-1/assessments",
    );
  });

  it("goes to the composer from a section blocker, carrying the section to open (R8)", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    await user.click(within(panel()).getByRole("button", { name: "Go to Assessment" }));
    expect((await screen.findByLabelText("location")).textContent).toBe(
      "/patients/patient-1/encounters/enc-1/compose?focus=section%3Aassessment",
    );
  });

  it("has no axe violations in the blocked panel", async () => {
    const user = userEvent.setup();
    await finalizeRefused(user);
    expect((await axe.run(panel())).violations).toEqual([]);
  });
});

describe("a finalize the server could not decide", () => {
  it("says it in fixed words, never the server's text, and asks again on Try again", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const { post } = mount(async (path, init) => {
      answers += 1;
      return answers === 1
        ? refused(
            503,
            "COMPLIANCE_GATE_UNAVAILABLE",
            [],
            "scales reader failed: ECONNREFUSED 10.0.0.5",
          )(path, init)
        : accepted("finalized")(path, init);
    });
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    expect(
      await within(panel()).findByText(
        "The server could not run its checks right now, so the note was not finalized. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("ECONNREFUSED");

    await user.click(within(panel()).getByRole("button", { name: "Try again" }));
    expect(await within(panel()).findByText("Finalized, not signed")).toBeInTheDocument();
    expect(callsTo(post, FINALIZE_PATH)).toHaveLength(2);
  });

  it("says the result is not known when the request never got an answer, and gives the form back", async () => {
    const user = userEvent.setup();
    mount(async () => {
      throw new Error("network down");
    });
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    expect(
      await within(panel()).findByText(/The connection was interrupted before the server answered/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finalize note" })).toBeEnabled();
  });
});

describe("finalized is not signed (T10)", () => {
  it("says finalized, not signed after the server accepts the finalize, and offers the Sign step", async () => {
    const user = userEvent.setup();
    mount(accepted("finalized"));
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    expect(await within(panel()).findByText("Finalized, not signed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign encounter" })).toBeInTheDocument();
    expect(screen.getByText("Awaiting signature")).toBeInTheDocument();
    expect(
      screen.getByText("The note is finalized and its text is frozen. It is not signed."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ready for signature")).toBeNull();
    expect(screen.queryByText(/can now be signed/)).toBeNull();
  });

  it("shows a note that was already finalized as finalized, not signed, from the server's status", async () => {
    status = "finalized";
    mount(accepted("signed"));
    await findPanel();
    expect(within(panel()).getByText("Finalized, not signed")).toBeInTheDocument();
    expect(screen.queryByText("Ready for signature")).toBeNull();
  });

  it("shows no panel for a note that is signed", async () => {
    status = "signed";
    mount(accepted("signed"));
    await screen.findByRole("heading", { name: "Routine Visit" });
    expect(screen.queryByRole("region", { name: "Finalize and sign checks" })).toBeNull();
  });
});

describe("a note documented late", () => {
  it("asks for the reason once the server does, focuses the field from the remedy, and sends it with the next finalize", async () => {
    const user = userEvent.setup();
    let answers = 0;
    const { post } = mount(async (path, init) => {
      answers += 1;
      return answers === 1
        ? refused(422, "LATE_ENTRY_REASON_REQUIRED")(path, init)
        : accepted("finalized")(path, init);
    });
    await findPanel();
    expect(screen.queryByLabelText("Late-entry reason")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await user.click(
      await within(panel()).findByRole("button", { name: "Enter the late-entry reason" }),
    );
    const field = screen.getByLabelText("Late-entry reason");
    expect(field).toHaveFocus();
    await user.type(field, FORTY);
    await user.click(screen.getByRole("button", { name: "Finalize note" }));

    await within(panel()).findByText("Finalized, not signed");
    const bodies = callsTo(post, FINALIZE_PATH).map(([, init]) => (init as { body: unknown }).body);
    expect(bodies).toEqual([{}, { lateEntryReason: FORTY }]);
  });
});

describe("a refused sign", () => {
  async function signRefused(
    user: ReturnType<typeof userEvent.setup>,
    code: string,
    details: unknown[] = [],
  ) {
    status = "finalized";
    const view = mount(async (path, init) =>
      path === SIGN_PATH ? refused(422, code, details)(path, init) : accepted("signed")(path, init),
    );
    await user.click(await screen.findByRole("button", { name: "Sign encounter" }));
    await user.click(await screen.findByRole("checkbox", { name: /complete and accurate/i }));
    await user.click(screen.getByRole("button", { name: /sign & commit/i }));
    return view;
  }

  it("keeps the dialog's own message, and lists the server's failures in the panel once the dialog closes", async () => {
    const user = userEvent.setup();
    await signRefused(user, "COMPLIANCE_GATE_FAILED", [
      { field: "bp", code: "MISSING_VITAL", message: "m" },
    ]);
    const dialog = await screen.findByRole("dialog", { name: "Sign encounter" });
    await waitFor(() => within(dialog).getByRole("alert"));
    // The dialog keeps focus while it is open: the panel does not take it.
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Sign encounter" })).toBeNull(),
    );
    expect(within(panel()).getByText("Blocked: 1 item to fix")).toBeInTheDocument();
    expect(within(panel()).getByText("Blood pressure is not recorded")).toBeInTheDocument();
    expect(within(panel()).getByText(/The note was not signed\./)).toBeInTheDocument();
    await waitFor(() => expect(firstBlocker()).toHaveFocus());
  });

  it("leaves focus on the Sign button when a second Sign dialog is cancelled over the same refusal", async () => {
    const user = userEvent.setup();
    await signRefused(user, "COMPLIANCE_GATE_FAILED", [
      { field: "bp", code: "MISSING_VITAL", message: "m" },
    ]);
    const first = await screen.findByRole("dialog", { name: "Sign encounter" });
    await waitFor(() => within(first).getByRole("alert"));
    await user.click(within(first).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(firstBlocker()).toHaveFocus());

    // Sign again, then think better of it: the refusal on screen is the one focus already went to.
    const signButton = screen.getByRole("button", { name: "Sign encounter" });
    await user.click(signButton);
    const second = await screen.findByRole("dialog", { name: "Sign encounter" });
    await user.click(within(second).getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Sign encounter" })).toBeNull(),
    );
    expect(signButton).toHaveFocus();
    expect(firstBlocker()).not.toHaveFocus();
  });

  it("says an LPN or aide note with no RN to cosign is advice with no button", async () => {
    const user = userEvent.setup();
    await signRefused(user, "NO_ELIGIBLE_COSIGNER");
    await user.click(
      within(await screen.findByRole("dialog", { name: "Sign encounter" })).getByRole("button", {
        name: /cancel/i,
      }),
    );
    expect(await within(panel()).findByText("No RN is available to cosign")).toBeInTheDocument();
    expect(within(panel()).queryAllByRole("button")).toHaveLength(0);
  });

  it("says at sign that a late-entry reason is required and cannot be entered on this screen yet, with no button and no field (C4)", async () => {
    const user = userEvent.setup();
    await signRefused(user, "LATE_ENTRY_REASON_REQUIRED");
    await user.click(
      within(await screen.findByRole("dialog", { name: "Sign encounter" })).getByRole("button", {
        name: /cancel/i,
      }),
    );
    expect(await within(panel()).findByText("A late-entry reason is required")).toBeInTheDocument();
    expect(
      within(panel()).getByText(
        /The reason is required, and it cannot be entered on this screen yet\./,
      ),
    ).toBeInTheDocument();
    expect(within(panel()).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Late-entry reason")).toBeNull();
  });

  it("says what a sign does, not what a finalize does, and names the checks the sign gate never reached (R15, C3)", async () => {
    const user = userEvent.setup();
    await signRefused(user, "COMPLIANCE_GATE_FAILED", [
      { field: "bp", code: "MISSING_VITAL", message: "m" },
    ]);
    await user.click(
      within(await screen.findByRole("dialog", { name: "Sign encounter" })).getByRole("button", {
        name: /cancel/i,
      }),
    );
    await within(panel()).findByText("Blocked: 1 item to fix");
    expect(
      within(panel()).getByText(
        "Signing runs the server checks again; if they pass the note is signed.",
      ),
    ).toBeInTheDocument();
    expect(within(panel()).queryByText(/Finalize runs the server checks/)).toBeNull();
    expect(
      within(panel()).getByText(
        /the RN cosigner, the face-to-face record, the visit delivery and times\) were not reached/,
      ),
    ).toBeInTheDocument();
  });

  it("sends no late-entry reason with the sign (WP4 owns that ceremony)", async () => {
    const user = userEvent.setup();
    const { post } = await signRefused(user, "NO_ELIGIBLE_COSIGNER");
    await screen.findByRole("dialog", { name: "Sign encounter" });
    const [, init] = callsTo(post, SIGN_PATH)[0] as [string, { body: Record<string, unknown> }];
    expect(init.body).not.toHaveProperty("lateEntryReason");
    expect(init.body.attestationConfirmed).toBe(true);
  });
});

describe("the way back and the part of the note to open (R8)", () => {
  const FROM = "/me/visits?status=open";
  const entry = `/patients/patient-1/encounters/enc-1?from=${encodeURIComponent(FROM)}`;
  const where = async (): Promise<string> =>
    (await screen.findByLabelText("location")).textContent ?? "";

  async function refusedWith(
    user: ReturnType<typeof userEvent.setup>,
    details: unknown[],
    label: string,
  ): Promise<void> {
    mount(refused(422, "COMPLIANCE_GATE_FAILED", details), entry);
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await user.click(await within(panel()).findByRole("button", { name: label }));
  }

  it("opens the composer at the vitals, keeping the way back", async () => {
    const user = userEvent.setup();
    await refusedWith(
      user,
      [{ field: "bp", code: "MISSING_VITAL", message: "m" }],
      "Open visit vitals",
    );
    expect(await where()).toBe(
      `/patients/patient-1/encounters/enc-1/compose?focus=vitals&from=${encodeURIComponent(FROM)}`,
    );
  });

  it("opens the composer at the drafted section to review, keeping the way back", async () => {
    const user = userEvent.setup();
    await refusedWith(
      user,
      [{ field: "plan", code: "DRAFT_SECTION_UNRESOLVED", message: "m" }],
      "Review Plan",
    );
    expect(await where()).toBe(
      `/patients/patient-1/encounters/enc-1/compose?focus=section%3Aplan&from=${encodeURIComponent(FROM)}`,
    );
  });

  it("says the record cannot save the selections: that remedy opens the composer, with no part named", async () => {
    const user = userEvent.setup();
    mount(refused(409, "VOCAB_VERSION_MISMATCH", [], "m"), entry);
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await within(panel()).findByText("Blocked: 1 item to fix");
    expect(screen.queryByRole("button", { name: "Save the selections again" })).toBeNull();
    await user.click(within(panel()).getByRole("button", { name: "Open the composer" }));
    expect(await where()).toBe(
      `/patients/patient-1/encounters/enc-1/compose?from=${encodeURIComponent(FROM)}`,
    );
  });
});

describe("where focus goes on the record", () => {
  it("moves focus to the panel when the server could not decide (R1)", async () => {
    const user = userEvent.setup();
    mount(refused(503, "COMPLIANCE_GATE_UNAVAILABLE", [], "m"));
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await within(panel()).findByText("Unavailable");
    await waitFor(() => expect(panel()).toHaveFocus());
  });

  it("reads the note again in place after a finalize, keeping the panel and moving focus to it (R3)", async () => {
    const user = userEvent.setup();
    mount(accepted("finalized"));
    const before = await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await within(panel()).findByText("Finalized, not signed");
    // Not replaced by a spinner and rebuilt: it is the panel that was on screen, so its live region said the result.
    expect(panel()).toBe(before);
    await waitFor(() => expect(panel()).toHaveFocus());
  });
});

describe("a note that moved on in another tab (C2)", () => {
  it("reads the note again, in place, and says the server refused without claiming it was not finalized", async () => {
    const user = userEvent.setup();
    const { get } = mount(async (path, init) => {
      status = "finalized";
      return refused(409, "ILLEGAL_TRANSITION", [], "encounter is finalized")(path, init);
    });
    await findPanel();
    const reads = () =>
      get.mock.calls.filter(([path]) => path === "/api/v1/encounters/{encounterId}").length;
    expect(reads()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await within(panel()).findByText("Refused: the note changed elsewhere");
    await waitFor(() => expect(reads()).toBe(2));
    expect(panel().textContent).not.toMatch(/was not finalized|Nothing was frozen/);
    expect(await screen.findByRole("button", { name: "Sign encounter" })).toBeInTheDocument();
  });
});

describe("an account that may read the note but not author encounters", () => {
  const READ_ONLY = ["encounter.read", "encounter.finalize"];
  const FAILURES = [{ field: "assessment", code: "MISSING_SECTION", message: "m" }];

  it("is told Document is unavailable, and why, instead of being sent to a route it is refused", async () => {
    mount(accepted("finalized"), undefined, READ_ONLY);
    await findPanel();
    const strip = screen.getByRole("navigation", { name: "Note workflow" });
    expect(within(strip).queryByRole("link", { name: "Document" })).toBeNull();
    const documentStep = within(strip).getByRole("button", { name: "Document" });
    expect(documentStep).toHaveAttribute("aria-disabled", "true");
    expect(documentStep).toHaveAccessibleDescription(/You can read this note but not edit it/);
  });

  it("shows Compose note unavailable, with the reason, and goes nowhere when it is pressed", async () => {
    const user = userEvent.setup();
    mount(accepted("finalized"), undefined, READ_ONLY);
    await findPanel();
    const compose = screen.getByRole("button", { name: "Compose note" });
    expect(compose).toHaveAttribute("aria-disabled", "true");
    expect(compose).toHaveAccessibleDescription(/You can read this note but not edit it/);
    // One sentence on the page, not two: the Document step shows it and the button is described by it.
    expect(screen.getAllByText(/You can read this note but not edit it/)).toHaveLength(1);
    await user.click(compose);
    expect(screen.getByLabelText("location").textContent).toBe(
      "/patients/patient-1/encounters/enc-1",
    );
  });

  it("stays on the record, with the reason in the page alert, when a blocker's remedy would open the composer", async () => {
    const user = userEvent.setup();
    mount(refused(422, "COMPLIANCE_GATE_FAILED", FAILURES), undefined, READ_ONLY);
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await user.click(await within(panel()).findByRole("button", { name: "Go to Assessment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /You can read this note but not edit it/,
    );
    expect(screen.getByLabelText("location").textContent).toBe(
      "/patients/patient-1/encounters/enc-1",
    );
  });

  it("still goes to the screens that are not the composer", async () => {
    const user = userEvent.setup();
    mount(
      refused(422, "COMPLIANCE_GATE_FAILED", [
        { field: "pps", code: "MISSING_SCALE", message: "m" },
      ]),
      undefined,
      READ_ONLY,
    );
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await user.click(await within(panel()).findByRole("button", { name: "Open assessments" }));
    expect((await screen.findByLabelText("location")).textContent).toBe(
      "/patients/patient-1/assessments",
    );
  });
});

describe("a read after the note moved on that cannot reach the server", () => {
  const LOAD_FAILED = "Could not load the encounter. Check your connection and try again.";

  it("shows the load-failure state after a refused finalize, with no unhandled rejection", async () => {
    const user = userEvent.setup();
    mount(async (path, init) => {
      encounterReadFails = true;
      return refused(409, "ILLEGAL_TRANSITION", [], "encounter is finalized")(path, init);
    });
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    expect(await screen.findByText(LOAD_FAILED)).toBeInTheDocument();
  });

  it("shows the load-failure state after a refused sign, with no unhandled rejection", async () => {
    const user = userEvent.setup();
    status = "finalized";
    mount(async (path, init) => {
      encounterReadFails = true;
      return refused(409, "IMMUTABLE_AFTER_SIGN", [], "encounter is signed")(path, init);
    });
    await user.click(await screen.findByRole("button", { name: "Sign encounter" }));
    await user.click(await screen.findByRole("checkbox", { name: /complete and accurate/i }));
    await user.click(screen.getByRole("button", { name: /sign & commit/i }));
    expect(await screen.findByText(LOAD_FAILED)).toBeInTheDocument();
  });
});

describe("the checks panel on the record", () => {
  it("is not rendered again by a keystroke elsewhere on the screen", async () => {
    const user = userEvent.setup();
    mount(
      refused(422, "COMPLIANCE_GATE_FAILED", [
        { field: "assessment", code: "MISSING_SECTION", message: "m" },
      ]),
    );
    await findPanel();
    await user.click(screen.getByRole("button", { name: "Finalize note" }));
    await within(panel()).findByText("Blocked: 1 item to fix");
    const rendered = panelRenders.count;

    await user.type(screen.getByLabelText(/Heart rate/), "72");

    expect(screen.getByLabelText(/Heart rate/)).toHaveValue("72");
    expect(panelRenders.count).toBe(rendered);
  });
});
