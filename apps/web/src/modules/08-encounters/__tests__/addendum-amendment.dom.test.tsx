// @vitest-environment jsdom
// An addendum that amends sections of a signed drafted note (ADR-0114 VN-D30, S1 PR E3): each named section shows its redrafted text from
// the addendum's OWN draft with confirm and deselect, Sign waits (naming the sections) until each is resolved, every refusal has a next
// step, a deselected section amends nothing and says so, and a free addendum never reads a draft. Synthetic data only.
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { AddendumRow } from "../addenda-api";
import { AddendaPanel } from "../addendum-panel";

const DRAFT_PATH = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/draft";
const PUT_PATH = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/draft/sections/{sectionId}";
const SIGN_PATH = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/sign";

const amending: AddendumRow = {
  id: "add-1",
  status: "finalized",
  reason: "Pain pattern changed after the family call",
  authoredByUserId: "mem-author",
  createdAt: "2026-10-01T10:00:00Z",
  signedAt: null,
  version: 0,
  amendsSectionIds: ["pain", "plan"],
};

const section = (sectionId: string, state: string, text = `Redrafted ${sectionId}.`) => ({
  sectionId,
  state,
  text: state === "not_drafted" ? null : text,
  contentHash: state === "not_drafted" ? null : `hash-${sectionId}`,
  corpusVersion: state === "not_drafted" ? null : "2026.1.0",
  part2Derived: state === "not_drafted" ? null : false,
  origins: state === "not_drafted" ? [] : ["vitals"],
});

let sections: ReturnType<typeof section>[];
let draftAnswer: "ok" | "off" | "unavailable";

const answerDraft = () => {
  if (draftAnswer === "off") {
    return {
      error: { error: { code: "NOT_FOUND", message: "not found" } },
      response: { status: 404 },
    };
  }
  if (draftAnswer === "unavailable") {
    return {
      error: { error: { code: "DRAFT_UNAVAILABLE", message: "no" } },
      response: { status: 503 },
    };
  }
  return {
    data: {
      addendumId: "add-1",
      encounterId: "enc-1",
      patientId: "patient-1",
      templateKey: "routine_visit:rn",
      asOf: "2026-10-01T23:59:59.999Z",
      sections,
    },
  };
};

beforeEach(() => {
  sections = [section("pain", "unresolved"), section("plan", "unresolved")];
  draftAnswer = "ok";
});
afterEach(cleanup);

type PutImpl = (path: string, init: { body: { resolution: string } }) => Promise<unknown>;
const resolvedPut: PutImpl = async (_path, init) => ({
  data: {
    ...section("pain", init.body.resolution === "confirmed" ? "confirmed" : "deselected"),
  },
});

function mount(
  addenda: readonly AddendumRow[],
  over: { POST?: ReturnType<typeof vi.fn>; PUT?: PutImpl } = {},
) {
  const onChanged = vi.fn();
  const GET = vi.fn(async (path: string) => {
    if (path === DRAFT_PATH) return answerDraft();
    return {
      data: { templateKey: "k", vocabVersion: "v", sections: [], layer1Preview: "", version: 1 },
    };
  });
  const PUT = vi.fn(over.PUT ?? resolvedPut);
  const POST = over.POST ?? vi.fn(async () => ({ data: { status: "signed" } }));
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <ApiClientProvider client={{ GET, PUT, POST, PATCH: vi.fn() } as never}>
            <SessionProvider session={null}>
              <AddendaPanel encounterId="enc-1" addenda={addenda} onChanged={onChanged} />
            </SessionProvider>
          </ApiClientProvider>
        ),
      },
    ],
    { initialEntries: ["/patients/patient-1/encounters/enc-1"] },
  );
  render(<RouterProvider router={router} />);
  return { GET, PUT, POST, onChanged };
}

const row = () => screen.getByLabelText("Addendum add-1");
const review = async () => within(await screen.findByRole("region", { name: "Amended sections" }));
const draftReads = (GET: ReturnType<typeof mount>["GET"]) =>
  GET.mock.calls.filter(([path]) => path === DRAFT_PATH).length;

describe("the amended sections of an addendum", () => {
  it("names them and shows each one's redrafted text from the addendum's own draft", async () => {
    const { GET } = mount([amending]);
    const inReview = await review();
    expect(await inReview.findByText("Redrafted pain.")).toBeInTheDocument();
    expect(inReview.getByText("Redrafted plan.")).toBeInTheDocument();
    expect(within(row()).getByText("Pain, Plan")).toBeInTheDocument();
    expect(GET).toHaveBeenCalledWith(DRAFT_PATH, {
      params: { path: { encounterId: "enc-1", addendumId: "add-1" } },
    });
  });

  it("reads no draft for a free addendum, and offers nothing to review", () => {
    const { GET } = mount([
      { ...amending, amendsSectionIds: [] },
      { ...amending, id: "add-2", amendsSectionIds: undefined },
    ]);
    expect(GET.mock.calls.filter(([p]) => p === DRAFT_PATH)).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Amended sections" })).toBeNull();
  });

  it("confirms a section against the hash and corpus version it showed", async () => {
    const user = userEvent.setup();
    const { PUT } = mount([amending]);
    const inReview = await review();
    await inReview.findByText("Redrafted pain.");
    await user.click(
      inReview.getAllByRole("button", { name: "Confirm section" })[0] as HTMLElement,
    );
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    expect(PUT).toHaveBeenCalledWith(PUT_PATH, {
      params: { path: { encounterId: "enc-1", addendumId: "add-1", sectionId: "pain" } },
      body: { resolution: "confirmed", contentHash: "hash-pain", corpusVersion: "2026.1.0" },
    });
    expect(
      await inReview.findByText(/will be amended with the text you confirmed/),
    ).toBeInTheDocument();
  });

  it("says a deselected section amends nothing", async () => {
    const user = userEvent.setup();
    mount([amending]);
    const inReview = await review();
    await inReview.findByText("Redrafted pain.");
    await user.click(
      inReview.getAllByRole("button", { name: "Deselect section" })[0] as HTMLElement,
    );
    expect(
      await inReview.findByText(/this amends nothing, and the section stays as it was signed/),
    ).toBeInTheDocument();
  });

  it("says a section with nothing to redraft amends nothing", async () => {
    sections = [section("pain", "confirmed"), section("plan", "not_drafted")];
    mount([amending]);
    const inReview = await review();
    expect(
      await inReview.findByText(/Nothing in the record to redraft this section/),
    ).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    mount([amending]);
    const inReview = await review();
    await inReview.findByText("Redrafted pain.");
    expect((await axe.run(row())).violations).toEqual([]);
  });
});

describe("Sign waits for the amended sections", () => {
  it("names the unresolved sections beside Sign, which stays reachable but opens nothing", async () => {
    const user = userEvent.setup();
    mount([amending]);
    const inReview = await review();
    await inReview.findByText("Redrafted pain.");
    const sign = within(row()).getByRole("button", { name: "Sign addendum" });
    expect(sign).toHaveAttribute("aria-disabled", "true");
    expect(sign).toHaveAccessibleDescription(
      /Pain \(not confirmed or deselected yet\), Plan \(not confirmed or deselected yet\)/,
    );
    sign.focus();
    expect(sign).toHaveFocus();
    await user.click(sign);
    expect(screen.queryByRole("dialog", { name: "Sign addendum" })).toBeNull();
  });

  it("names a section whose sources changed after it was resolved", async () => {
    sections = [section("pain", "confirmed"), section("plan", "needs_reconfirmation")];
    mount([amending]);
    const sign = await within(row()).findByRole("button", { name: "Sign addendum" });
    await waitFor(() =>
      expect(sign).toHaveAccessibleDescription(/Plan \(changed since you resolved it\)/),
    );
  });

  it("opens the sign ceremony once every named section is confirmed or deselected", async () => {
    const user = userEvent.setup();
    sections = [section("pain", "confirmed"), section("plan", "deselected")];
    mount([amending]);
    const sign = await within(row()).findByRole("button", { name: "Sign addendum" });
    await waitFor(() => expect(sign).not.toHaveAttribute("aria-disabled"));
    await user.click(sign);
    expect(screen.getByRole("dialog", { name: "Sign addendum" })).toBeInTheDocument();
  });

  it("waits while the amended sections are still being read", () => {
    mount([amending]);
    expect(within(row()).getByRole("button", { name: "Sign addendum" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("does not hold a free addendum back", () => {
    mount([{ ...amending, amendsSectionIds: [] }]);
    expect(within(row()).getByRole("button", { name: "Sign addendum" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("reviews the sections while the addendum is still a draft, and offers Finalize rather than Sign", async () => {
    mount([{ ...amending, status: "draft" }]);
    const inReview = await review();
    await inReview.findByText("Redrafted pain.");
    expect(within(row()).getByRole("button", { name: "Finalize addendum" })).toBeInTheDocument();
    expect(within(row()).queryByRole("button", { name: "Sign addendum" })).toBeNull();
  });
});

describe("when the amended sections cannot be shown", () => {
  it("says they could not be read, offers a retry that reads again, and holds Sign back", async () => {
    const user = userEvent.setup();
    draftAnswer = "unavailable";
    const { GET } = mount([amending]);
    const inReview = await review();
    expect(await inReview.findByText(/could not be read/)).toBeInTheDocument();
    expect(within(row()).getByRole("button", { name: "Sign addendum" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    draftAnswer = "ok";
    await user.click(inReview.getByRole("button", { name: "Try again" }));
    expect(await inReview.findByText("Redrafted pain.")).toBeInTheDocument();
    expect(draftReads(GET)).toBe(2);
  });

  it("says the draft is off or unreadable for this role, leaving the sign to the server", async () => {
    draftAnswer = "off";
    mount([amending]);
    const inReview = await review();
    expect(
      await inReview.findByText(
        /switched off for your organization, or your role does not include reading it/,
      ),
    ).toBeInTheDocument();
    expect(within(row()).getByRole("button", { name: "Sign addendum" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("explains a stale confirmation on resolve and re-reads the draft", async () => {
    const user = userEvent.setup();
    const { GET } = mount([amending], {
      PUT: async () => ({
        error: { error: { code: "DRAFT_SECTION_STALE", message: "stale" } },
        response: { status: 409 },
      }),
    });
    const inReview = await review();
    await inReview.findByText("Redrafted pain.");
    await user.click(
      inReview.getAllByRole("button", { name: "Confirm section" })[0] as HTMLElement,
    );
    expect(await inReview.findByText(/changed after you opened it/)).toBeInTheDocument();
    await waitFor(() => expect(draftReads(GET)).toBe(2));
  });
});

describe("a refused sign", () => {
  async function signRefused(error: { status: number; code: string; details?: unknown }) {
    const user = userEvent.setup();
    sections = [section("pain", "confirmed"), section("plan", "confirmed")];
    const POST = vi.fn(async (path: string) =>
      path === SIGN_PATH
        ? {
            error: { error: { code: error.code, message: "server words", details: error.details } },
            response: { status: error.status },
          }
        : { data: {} },
    );
    const mounted = mount([amending], { POST });
    const sign = await within(row()).findByRole("button", { name: "Sign addendum" });
    await waitFor(() => expect(sign).not.toHaveAttribute("aria-disabled"));
    await user.click(sign);
    await user.click(screen.getByLabelText(/I attest this addendum/));
    await user.click(screen.getByRole("button", { name: "Sign & commit" }));
    return { ...mounted, alert: await screen.findByRole("alert") };
  }

  it("409 DRAFT_SECTION_STALE names the sections and re-reads the draft", async () => {
    const { alert, GET } = await signRefused({
      status: 409,
      code: "DRAFT_SECTION_STALE",
      details: [{ field: "plan", code: "DRAFT_SECTION_STALE", message: "m" }],
    });
    expect(alert.textContent).toContain("Plan (changed since you resolved it)");
    expect(alert.textContent).toMatch(/sign again/);
    await waitFor(() => expect(draftReads(GET)).toBe(2));
  });

  it.each([
    ["DRAFT_OFF_AFTER_FINALIZE", 409, /Visit-note Draft/],
    ["COMPLIANCE_GATE_UNAVAILABLE", 503, /Try again in a moment/],
    ["NO_ELIGIBLE_COSIGNER", 422, /cosigner/],
    ["AMENDMENT_PART2_NOT_ENTITLED", 422, /42 CFR Part 2/],
  ])("%s says what happened and what to do", async (code, status, wording) => {
    const { alert, onChanged } = await signRefused({ status, code });
    expect(alert.textContent).toMatch(wording);
    expect(alert.textContent).toMatch(/Nothing was changed|cannot be amended by you/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("a signed amendment", () => {
  it("says how many sections it amended and that a cosignature was requested", async () => {
    const user = userEvent.setup();
    sections = [section("pain", "confirmed"), section("plan", "deselected")];
    const POST = vi.fn(async () => ({
      data: {
        status: "signed",
        signedAt: "2026-10-02T10:00:00Z",
        amendedSectionIds: ["pain"],
        cosignatureRequestId: "req-1",
      },
    }));
    const { onChanged } = mount([amending], { POST });
    const sign = await within(row()).findByRole("button", { name: "Sign addendum" });
    await waitFor(() => expect(sign).not.toHaveAttribute("aria-disabled"));
    await user.click(sign);
    await user.click(screen.getByLabelText(/I attest this addendum/));
    await user.click(screen.getByRole("button", { name: "Sign & commit" }));
    expect(
      await screen.findByText(
        "Addendum signed. 1 section amended. A cosignature was requested for this amendment.",
      ),
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows what it amended and its cosignature status, and reads no draft", () => {
    const { GET } = mount([
      { ...amending, status: "signed", signedAt: "2026-10-02T10:00:00Z", cosignStatus: "cosigned" },
    ]);
    expect(within(row()).getByText("Pain, Plan")).toBeInTheDocument();
    expect(within(row()).getByText("Cosignature of this amendment")).toBeInTheDocument();
    expect(within(row()).getByText("Cosigned")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Amended sections" })).toBeNull();
    expect(draftReads(GET)).toBe(0);
  });

  it("shows no cosignature row when the API sent no status", () => {
    mount([{ ...amending, status: "signed", signedAt: "2026-10-02T10:00:00Z" }]);
    expect(within(row()).queryByText("Cosignature of this amendment")).toBeNull();
  });
});
