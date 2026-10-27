// @vitest-environment jsdom
// Milestone 10a — the NOMNC / QIO review panel: loud prompts for what is missing, deadlines shown exactly as typed
// with a minute-accurate countdown, drawer forms with NO prefilled date or time (every mode: readiness line + submit),
// 409 / failed-reload / stale-response handling, drawer re-key, focus and Escape. Fixtures are synthetic.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import {
  clearAllStepUpDrafts,
  markStepUpReturn,
  peekStepUpDraft,
  stepUpDraftKey,
} from "../../../shell/step-up-redirect";
import { NomncApiError } from "../nomnc-api";
import type { DeadlineView, NomncApi, NomncOverview, NoticeView, ReviewView } from "../nomnc-api";
import { countdownLabel, formatInZone, nextOpenDeadline, typedEcho } from "../nomnc-format";
import { NomncPanel, NomncPromptStrip, rebindMode } from "../nomnc-panel";

const READ_RECORD = ["nomnc.read", "nomnc.record"];
const session = (permissions: string[]): Session => ({
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Test Clinician",
  roles: ["rn"],
  permissions,
});

const notice = (over: Partial<NoticeView> = {}): NoticeView => ({
  id: "n-1",
  admissionId: "adm-1",
  status: "active",
  servicesEndOn: "2026-01-14",
  deliveredAt: "2026-01-10T15:30:00.000Z",
  recipientKind: "beneficiary",
  representativeName: null,
  deliveryNote: null,
  acknowledgementKind: null,
  acknowledgementNote: null,
  documentId: null,
  sourceNote: "NOMNC copy, page 2",
  withdrawnReason: null,
  version: 1,
  ...over,
});

const review = (over: Partial<ReviewView> = {}): ReviewView => ({
  id: "r-1",
  admissionId: "adm-1",
  nomncNoticeId: "n-1",
  state: "open",
  qioName: "Example BFCC-QIO",
  qioReference: null,
  qioNotifiedAt: "2026-01-10T19:20:00.000Z",
  requestedByKind: "unknown",
  dencDeliveredAt: null,
  recordsSentAt: null,
  recordsSentNote: null,
  decisionOutcome: null,
  decisionReceivedAt: null,
  decisionNote: null,
  version: 1,
  ...over,
});

const deadline = (over: Partial<DeadlineView> = {}): DeadlineView => ({
  id: "d-1",
  subject: "notice",
  subjectId: "n-1",
  kind: "appeal_request",
  label: null,
  dueAt: "2099-01-12T17:00:00.000Z",
  dueLocal: "2099-01-12T12:00",
  zone: "America/New_York",
  sourceNote: "printed on the NOMNC, line 3",
  satisfiedAt: null,
  status: "open",
  version: 1,
  ...over,
});

const overview = (over: Partial<NomncOverview> = {}): NomncOverview => ({
  admissionId: "adm-1",
  timeZone: "America/New_York",
  activeNotice: null,
  history: [],
  review: null,
  deadlines: [],
  prompts: [],
  ...over,
});

function fakeApi(ov: NomncOverview = overview()): NomncApi {
  return {
    overview: vi.fn(async () => ov),
    recordNotice: vi.fn(async () => notice()),
    setAcknowledgement: vi.fn(async () => notice()),
    withdrawNotice: vi.fn(async () => notice()),
    openReview: vi.fn(async () => review()),
    recordReviewFacts: vi.fn(async () => review()),
    withdrawReview: vi.fn(async () => review()),
    addNoticeDeadline: vi.fn(async () => deadline()),
    addReviewDeadline: vi.fn(async () => deadline({ subject: "review", subjectId: "r-1" })),
    editDeadline: vi.fn(async () => deadline()),
  };
}

const PATH = "/admissions/adm-1";
const OWNER = { userId: "11111111-1111-4111-8111-111111111111", organizationId: "org-1" };

/** Shows where the router is, so a test can see the redirect to /step-up. */
function Where(): JSX.Element {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
}

const wrap = (ui: JSX.Element, permissions: string[]) => (
  <ApiClientProvider client={{} as ApiClient}>
    <SessionProvider session={session(permissions)}>
      <MemoryRouter initialEntries={[PATH]}>
        {ui}
        <Where />
      </MemoryRouter>
    </SessionProvider>
  </ApiClientProvider>
);
afterEach(() => clearAllStepUpDrafts());
const where = () => screen.getByTestId("where").textContent;
const stepUpError = () => new NomncApiError("Step-up required", false, true);
const renderWith = (ui: JSX.Element, permissions: string[] = READ_RECORD) =>
  render(wrap(ui, permissions));

/** A full overview: an active notice (appeal deadline typed), an open review, a review deadline. */
const FULL = overview({
  activeNotice: notice({ acknowledgementKind: "signed", version: 4 }),
  review: review({ version: 3 }),
  deadlines: [
    deadline(),
    deadline({
      id: "d-2",
      subject: "review",
      subjectId: "r-1",
      kind: "denc_delivery",
      dueLocal: "2099-01-13T09:30",
      dueAt: "2099-01-13T14:30:00.000Z",
      sourceNote: "told by the QIO on the call",
    }),
  ],
});

const fill = (label: RegExp | string, value: string, nth = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[nth] as HTMLElement, { target: { value } });
const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const needs = () => screen.queryByText(/^Needs:/)?.textContent ?? null;

describe("nomnc-format", () => {
  it("shows an instant in the ORGANIZATION's zone, not the viewer's", () => {
    expect(formatInZone("2026-01-12T17:00:00.000Z", "America/New_York")).toMatch(
      /Jan 12, 2026.*12:00 PM EST/,
    );
    expect(formatInZone(null, "America/New_York")).toBe("—");
  });

  it("counts down to the minute, and past due", () => {
    const now = new Date("2026-01-12T12:00:00.000Z");
    expect(countdownLabel("2026-01-12T15:20:00.000Z", now)).toBe("3 h 20 min left");
    expect(countdownLabel("2026-01-12T12:45:00.000Z", now)).toBe("45 min left");
    expect(countdownLabel("2026-01-14T12:00:00.000Z", now)).toBe("2 d left");
    expect(countdownLabel("2026-01-12T09:55:00.000Z", now)).toBe("Past due by 2 h 5 min");
  });

  it("echoes exactly what was typed and picks the soonest unsatisfied deadline", () => {
    expect(typedEcho("2026-01-12T12:00", "America/New_York")).toBe(
      "2026-01-12 12:00 (America/New_York)",
    );
    const rows = [
      { dueAt: "2026-01-13T00:00:00.000Z", satisfiedAt: null },
      { dueAt: "2026-01-11T00:00:00.000Z", satisfiedAt: "2026-01-10T00:00:00.000Z" },
      { dueAt: "2026-01-12T00:00:00.000Z", satisfiedAt: null },
    ];
    expect(nextOpenDeadline(rows)?.dueAt).toBe("2026-01-12T00:00:00.000Z");
    expect(nextOpenDeadline([])).toBeNull();
  });
});

describe("rebindMode", () => {
  it("points a form at the fresh record with the same id, and drops one that no longer applies", () => {
    const stale = notice({ version: 1 });
    const fresh = notice({ version: 5 });
    const ov = overview({ activeNotice: fresh });
    expect(rebindMode({ kind: "acknowledgement", notice: stale }, ov)).toEqual({
      kind: "acknowledgement",
      notice: fresh,
    });
    expect(rebindMode({ kind: "acknowledgement", notice: notice({ id: "other" }) }, ov)).toBeNull();
    expect(rebindMode({ kind: "decision", review: review() }, ov)).toBeNull();
    const done = overview({ activeNotice: fresh, review: review({ state: "decided" }) });
    expect(rebindMode({ kind: "decision", review: review() }, done)).toBeNull();
    const withDeadline = overview({ activeNotice: fresh, deadlines: [deadline({ version: 7 })] });
    expect(
      rebindMode({ kind: "edit_deadline", deadline: deadline({ version: 1 }) }, withDeadline),
    ).toMatchObject({ deadline: { version: 7 } });
  });
});

describe("NomncPanel", () => {
  it("with no record: says so and offers to record, with no deadline invented", async () => {
    renderWith(<NomncPanel admissionId="adm-1" api={fakeApi()} />);
    expect(await screen.findByText("No NOMNC delivery recorded for this admission.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record NOMNC delivery" })).toBeTruthy();
  });

  it("shows the loud prompts (warnings announced as alerts) and the 'not a computed CMS time' label", async () => {
    const ov = overview({
      activeNotice: notice(),
      prompts: [
        {
          code: "NO_APPEAL_DEADLINE",
          severity: "warn",
          message: "No deadline recorded: enter it from the notice.",
        },
        {
          code: "NO_ACKNOWLEDGEMENT",
          severity: "info",
          message: "Signature or refusal not recorded.",
        },
      ],
    });
    renderWith(<NomncPanel admissionId="adm-1" api={fakeApi(ov)} />);
    const warn = await screen.findAllByText("No deadline recorded: enter it from the notice.");
    expect(warn.some((el) => el.closest('[role="alert"]'))).toBe(true);
    expect(
      screen.getByText("Signature or refusal not recorded.").closest('[role="status"]'),
    ).toBeTruthy();
    expect(
      screen.getByText(/from your notice or the QIO's call, not a computed CMS time/),
    ).toBeTruthy();
  });

  it("shows a typed deadline exactly as typed, with a unique Mark met label, and marks it met", async () => {
    const api = fakeApi(FULL);
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    expect(await screen.findByText("2099-01-12 12:00 (America/New_York)")).toBeTruthy();
    expect(screen.getByText("printed on the NOMNC, line 3")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Mark Appeal request deadline due 2099-01-12 12:00 met" }),
    );
    await waitFor(() =>
      expect(api.editDeadline).toHaveBeenCalledWith(
        "adm-1",
        expect.objectContaining({ id: "d-1" }),
        {
          satisfy: true,
        },
      ),
    );
    // the second row has its own distinct label
    expect(
      screen.getByRole("button", { name: "Mark DENC delivery deadline due 2099-01-13 09:30 met" }),
    ).toBeTruthy();
  });

  it("a closed deadline is shown as Closed and offers no actions", async () => {
    const ov = overview({
      activeNotice: notice(),
      review: review({ state: "decided" }),
      deadlines: [
        deadline({ id: "d-9", subject: "review", kind: "qio_decision", status: "closed" }),
      ],
    });
    renderWith(<NomncPanel admissionId="adm-1" api={fakeApi(ov)} />);
    expect(await screen.findByText("Closed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark QIO decision/ })).toBeNull();
  });

  it("the record form starts EMPTY, names what is Needed (tied to Save), and submits typed values only", async () => {
    const api = fakeApi();
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record NOMNC delivery" }));
    expect((screen.getByLabelText(/^Date/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Time of day/) as HTMLInputElement).value).toBe("");
    expect(save().disabled).toBe(true);
    expect(needs()).toMatch(
      /last day of services; delivery date; delivery time of day; where this came from/,
    );
    expect(save().getAttribute("aria-describedby")).toBe(screen.getByText(/^Needs:/).id);

    fill(/^Last day of services/, "2026-01-14");
    fill(/^Date/, "2026-01-10");
    expect(needs()).toMatch(/delivery time of day/); // a date without a time is not submittable
    fill(/^Time of day/, "10:30");
    expect(save().disabled).toBe(true); // a source note is mandatory
    fill(/^Where this came from/, "signed copy");
    expect(needs()).toBeNull();
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.recordNotice).toHaveBeenCalledWith(
        "adm-1",
        expect.objectContaining({
          servicesEndOn: "2026-01-14",
          delivered: { date: "2026-01-10", time: "10:30" },
          sourceNote: "signed copy",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Record NOMNC delivery" })).toBeNull(),
    );
  });

  it("a representative recipient needs a name", async () => {
    renderWith(<NomncPanel admissionId="adm-1" api={fakeApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record NOMNC delivery" }));
    fireEvent.change(screen.getByLabelText("Delivered to"), {
      target: { value: "representative" },
    });
    expect(needs()).toMatch(/representative's name/);
  });

  describe("every other drawer mode: readiness line, then submit", () => {
    const openPanel = async (api: NomncApi) => {
      renderWith(<NomncPanel admissionId="adm-1" api={api} />);
      await screen.findByText("NOMNC and QIO review");
    };
    const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

    it("signature or refusal: refused needs a note", async () => {
      const api = fakeApi(overview({ activeNotice: notice() }));
      await openPanel(api);
      press("Signature or refusal");
      expect(needs()).toMatch(/what happened/);
      fireEvent.change(screen.getByLabelText("What happened"), { target: { value: "refused" } });
      expect(needs()).toMatch(/a note/);
      fill(/^Note/, "declined in person");
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.setAcknowledgement).toHaveBeenCalledWith(
          "adm-1",
          expect.objectContaining({ id: "n-1" }),
          "refused",
          "declined in person",
        ),
      );
    });

    it("withdraw the notice: needs a reason", async () => {
      const api = fakeApi(overview({ activeNotice: notice() }));
      await openPanel(api);
      press("Withdraw");
      expect(needs()).toMatch(/a reason/);
      fill(/^Why is this record being withdrawn/, "entered on the wrong chart");
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.withdrawNotice).toHaveBeenCalledWith(
          "adm-1",
          expect.objectContaining({ id: "n-1" }),
          "entered on the wrong chart",
        ),
      );
    });

    it("open the QIO review: needs the QIO name, and the date AND time", async () => {
      const api = fakeApi(overview({ activeNotice: notice() }));
      await openPanel(api);
      press("Open QIO review");
      expect(needs()).toMatch(/QIO name.*date.*time of day/);
      fill(/^QIO name/, "Example BFCC-QIO");
      fill(/^Date/, "2026-01-10");
      expect(save().disabled).toBe(true);
      fill(/^Time of day/, "14:20");
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.openReview).toHaveBeenCalledWith(
          "adm-1",
          expect.objectContaining({ id: "n-1" }),
          expect.objectContaining({
            qioName: "Example BFCC-QIO",
            qioNotified: { date: "2026-01-10", time: "14:20" },
          }),
        ),
      );
    });

    it("DENC and records: a 'how it was sent' note alone says the date and time are still needed", async () => {
      const api = fakeApi(FULL);
      await openPanel(api);
      press("DENC and records");
      expect(needs()).toMatch(/a DENC or records-sent date and time/);
      fill(/^How the records were sent/, "faxed");
      expect(needs()).toMatch(/records sent date; records sent time of day/);
      fill(/^Date/, "2026-01-10", 1);
      fill(/^Time of day/, "16:10", 1);
      expect(needs()).toBeNull();
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.recordReviewFacts).toHaveBeenCalledWith(
          "adm-1",
          expect.objectContaining({ id: "r-1" }),
          {
            recordsSent: { date: "2026-01-10", time: "16:10" },
            recordsSentNote: "faxed",
          },
        ),
      );
    });

    it("record the decision: 'other' needs a note", async () => {
      const api = fakeApi(FULL);
      await openPanel(api);
      press("Record decision");
      expect(needs()).toMatch(/the outcome/);
      fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "other" } });
      fill(/^Date/, "2026-01-10");
      fill(/^Time of day/, "18:00");
      expect(needs()).toMatch(/a note/);
      fill(/^Note/, "QIO asked for more records");
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.recordReviewFacts).toHaveBeenCalledWith(
          "adm-1",
          expect.objectContaining({ id: "r-1" }),
          {
            decision: {
              outcome: "other",
              received: { date: "2026-01-10", time: "18:00" },
              note: "QIO asked for more records",
            },
          },
        ),
      );
    });

    it("type a deadline on the notice: needs date, time and a source", async () => {
      const api = fakeApi(overview({ activeNotice: notice() }));
      await openPanel(api);
      press("Type a deadline");
      expect(needs()).toMatch(/due date; the due time of day; where this came from/);
      fill(/^Date/, "2026-01-12");
      fill(/^Time of day/, "12:00");
      fill(/^Where this came from/, "line 3 of the notice");
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.addNoticeDeadline).toHaveBeenCalledWith(
          "adm-1",
          expect.objectContaining({ id: "n-1" }),
          {
            kind: "appeal_request",
            label: null,
            due: { date: "2026-01-12", time: "12:00" },
            sourceNote: "line 3 of the notice",
          },
        ),
      );
    });

    it("type a deadline on the review", async () => {
      const api = fakeApi(FULL);
      await openPanel(api);
      const reviewGroup = screen.getByText("QIO expedited review").closest("div") as HTMLElement;
      fireEvent.click(within(reviewGroup).getByRole("button", { name: "Type a deadline" }));
      fireEvent.change(screen.getByLabelText("Deadline"), { target: { value: "qio_decision" } });
      fill(/^Date/, "2026-01-13");
      fill(/^Time of day/, "09:00");
      fill(/^Where this came from/, "told by the QIO on the call");
      fireEvent.click(save());
      await waitFor(() => expect(api.addReviewDeadline).toHaveBeenCalled());
    });

    it("edit a deadline: needs the new date, time and why", async () => {
      const api = fakeApi(FULL);
      await openPanel(api);
      press("Edit Appeal request deadline due 2099-01-12 12:00");
      expect(needs()).toMatch(/the new due date; the new due time of day; why it changed/);
      fill(/^Date/, "2099-01-12");
      fill(/^Time of day/, "11:45");
      fill(/^Where this came from/, "the notice was corrected");
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.editDeadline).toHaveBeenCalledWith(
          "adm-1",
          expect.objectContaining({ id: "d-1" }),
          {
            due: { date: "2099-01-12", time: "11:45" },
            sourceNote: "the notice was corrected",
          },
        ),
      );
    });
  });

  describe("drawer behaviour", () => {
    it("Escape and Cancel close it; focus moves into the drawer", async () => {
      renderWith(<NomncPanel admissionId="adm-1" api={fakeApi(FULL)} />);
      fireEvent.click(await screen.findByRole("button", { name: "Signature or refusal" }));
      const drawer = screen.getByRole("complementary", { name: "Signature or refusal" });
      await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
      fireEvent.keyDown(drawer, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("complementary", { name: "Signature or refusal" })).toBeNull(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Signature or refusal" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("complementary", { name: "Signature or refusal" })).toBeNull();
    });

    it("a different target is a different form: typed values never carry over", async () => {
      renderWith(<NomncPanel admissionId="adm-1" api={fakeApi(FULL)} />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Edit Appeal request deadline due 2099-01-12 12:00",
        }),
      );
      fill(/^Where this came from/, "typed for d-1");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Edit DENC delivery deadline due 2099-01-13 09:30" }),
      );
      expect((screen.getByLabelText(/^Where this came from/) as HTMLTextAreaElement).value).toBe(
        "",
      );
    });

    it("other actions are disabled while the open form has unsaved input", async () => {
      renderWith(<NomncPanel admissionId="adm-1" api={fakeApi(FULL)} />);
      fireEvent.click(await screen.findByRole("button", { name: "Signature or refusal" }));
      const other = screen.getByRole("button", { name: "Replace record" }) as HTMLButtonElement;
      expect(other.disabled).toBe(false);
      fireEvent.change(screen.getByLabelText("What happened"), { target: { value: "signed" } });
      await waitFor(() => expect(other.disabled).toBe(true));
    });
  });

  describe("failure paths", () => {
    it("409 on save: reloads, tells the user the record changed, rebinds to the fresh record and KEEPS what was typed", async () => {
      const stale = overview({ activeNotice: notice({ version: 1 }) });
      const fresh = overview({ activeNotice: notice({ version: 2 }) });
      const api = fakeApi(stale);
      vi.mocked(api.setAcknowledgement)
        .mockRejectedValueOnce(
          new NomncApiError("NOMNC record n-1 changed since it was read", true),
        )
        .mockResolvedValue(notice({ version: 3 }));
      renderWith(<NomncPanel admissionId="adm-1" api={api} />);
      fireEvent.click(await screen.findByRole("button", { name: "Signature or refusal" }));
      fireEvent.change(screen.getByLabelText("What happened"), { target: { value: "refused" } });
      fill(/^Note/, "declined in person");
      vi.mocked(api.overview).mockResolvedValue(fresh);
      fireEvent.click(save());
      expect(await screen.findByText(/This record changed while the form was open/)).toBeTruthy();
      expect((screen.getByLabelText(/^Note/) as HTMLTextAreaElement).value).toBe(
        "declined in person",
      );
      fireEvent.click(save());
      await waitFor(() =>
        expect(api.setAcknowledgement).toHaveBeenLastCalledWith(
          "adm-1",
          expect.objectContaining({ id: "n-1", version: 2 }),
          "refused",
          "declined in person",
        ),
      );
    });

    it("409 on Mark met reloads and says the record changed; any other failure shows the server's message", async () => {
      const api = fakeApi(FULL);
      vi.mocked(api.editDeadline)
        .mockRejectedValueOnce(new NomncApiError("deadline d-1 changed", true))
        .mockRejectedValueOnce(new NomncApiError("a satisfied deadline cannot change", false));
      renderWith(<NomncPanel admissionId="adm-1" api={api} />);
      const mark = await screen.findByRole("button", {
        name: "Mark Appeal request deadline due 2099-01-12 12:00 met",
      });
      fireEvent.click(mark);
      expect(await screen.findByText(/This record changed since you opened it/)).toBeTruthy();
      expect(vi.mocked(api.overview).mock.calls.length).toBeGreaterThanOrEqual(2);
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Mark Appeal request deadline due 2099-01-12 12:00 met",
        }),
      );
      expect(await screen.findByText("a satisfied deadline cannot change")).toBeTruthy();
    });

    it("a failed reload keeps the previous record on screen with a non-destructive alert and Retry", async () => {
      const api = fakeApi(FULL);
      renderWith(<NomncPanel admissionId="adm-1" api={api} />);
      await screen.findByText("2099-01-12 12:00 (America/New_York)");
      vi.mocked(api.overview).mockRejectedValueOnce(new Error("network down"));
      fireEvent.click(
        screen.getByRole("button", {
          name: "Mark Appeal request deadline due 2099-01-12 12:00 met",
        }),
      );
      expect(await screen.findByText(/Could not refresh this record/)).toBeTruthy();
      expect(screen.getByText("2099-01-12 12:00 (America/New_York)")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByText(/Could not refresh this record/)).toBeNull());
    });

    it("a first load that fails shows the error and Retry", async () => {
      const api = fakeApi();
      vi.mocked(api.overview).mockRejectedValueOnce(new Error("boom"));
      renderWith(<NomncPanel admissionId="adm-1" api={api} />);
      expect(await screen.findByText("boom")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(
        await screen.findByText("No NOMNC delivery recorded for this admission."),
      ).toBeTruthy();
    });

    it("a slow response for the previous admission never replaces the current one", async () => {
      let resolveA: (o: NomncOverview) => void = () => undefined;
      const api = fakeApi();
      vi.mocked(api.overview).mockImplementation((id) =>
        id === "adm-A"
          ? new Promise<NomncOverview>((r) => {
              resolveA = r;
            })
          : Promise.resolve(
              overview({
                admissionId: "adm-B",
                activeNotice: notice({ id: "n-B", sourceNote: "B notice" }),
              }),
            ),
      );
      const { rerender } = renderWith(<NomncPanel admissionId="adm-A" api={api} />);
      rerender(wrap(<NomncPanel admissionId="adm-B" api={api} />, READ_RECORD));
      expect(await screen.findByText("B notice")).toBeTruthy();
      resolveA(
        overview({
          admissionId: "adm-A",
          activeNotice: notice({ id: "n-A", sourceNote: "A notice" }),
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText("A notice")).toBeNull();
      expect(screen.getByText("B notice")).toBeTruthy();
    });
  });

  describe("permissions", () => {
    it("a reader without nomnc.record sees the facts but no record actions", async () => {
      renderWith(
        <NomncPanel admissionId="adm-1" api={fakeApi(overview({ activeNotice: notice() }))} />,
        ["nomnc.read"],
      );
      expect(await screen.findByText("NOMNC and QIO review")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Open QIO review" })).toBeNull();
    });

    it("without nomnc.read, or with an unknown permission set, nothing renders and nothing is fetched", () => {
      for (const perms of [["admission.read"], [] as string[]]) {
        const api = fakeApi();
        const { container, unmount } = renderWith(
          <NomncPanel admissionId="adm-1" api={api} />,
          perms,
        );
        expect(container.textContent).toBe(PATH); // only the router probe: the panel renders nothing
        expect(api.overview).not.toHaveBeenCalled();
        unmount();
      }
      const api = fakeApi();
      const { container } = render(
        <ApiClientProvider client={{} as ApiClient}>
          <SessionProvider session={{ ...session([]), permissions: undefined }}>
            <MemoryRouter>
              <NomncPanel admissionId="adm-1" api={api} />
            </MemoryRouter>
          </SessionProvider>
        </ApiClientProvider>,
      );
      expect(container.textContent).toBe("");
      expect(api.overview).not.toHaveBeenCalled();
    });
  });
});

describe("step-up on the irreversible writes", () => {
  const returnTo = encodeURIComponent(PATH);
  const NOTICE_ONLY = overview({ activeNotice: notice({ acknowledgementKind: "signed" }) });

  it("withdraw notice: a stale session goes to /step-up, the typed reason survives, and the form reopens on return", async () => {
    const api = fakeApi(NOTICE_ONLY);
    vi.mocked(api.withdrawNotice).mockRejectedValueOnce(stepUpError());
    const first = renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    fill(/^Why is this record being withdrawn/, "entered on the wrong chart");
    fireEvent.click(save());
    await waitFor(() => expect(where()).toBe(`/step-up?returnTo=${returnTo}`));
    expect(peekStepUpDraft(stepUpDraftKey(OWNER, "m6-nomnc-withdraw-notice", "n-1"))).toEqual({
      reason: "entered on the wrong chart",
    });
    first.unmount();

    // back from the ceremony: the one-shot marker names this path
    markStepUpReturn(PATH);
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    expect(
      await screen.findByRole("complementary", { name: "Withdraw NOMNC record" }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText(/^Why is this record being withdrawn/) as HTMLTextAreaElement).value,
    ).toBe("entered on the wrong chart");
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.withdrawNotice).toHaveBeenLastCalledWith(
        "adm-1",
        expect.objectContaining({ id: "n-1" }),
        "entered on the wrong chart",
      ),
    );
    await waitFor(() =>
      expect(peekStepUpDraft(stepUpDraftKey(OWNER, "m6-nomnc-withdraw-notice", "n-1"))).toBeNull(),
    );
  });

  it("record decision: outcome, time and note survive the round trip", async () => {
    const api = fakeApi(FULL);
    vi.mocked(api.recordReviewFacts).mockRejectedValueOnce(stepUpError());
    const first = renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record decision" }));
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "other" } });
    fill(/^Date/, "2026-01-10");
    fill(/^Time of day/, "18:00");
    fill(/^Note/, "QIO asked for more records");
    fireEvent.click(save());
    await waitFor(() => expect(where()).toBe(`/step-up?returnTo=${returnTo}`));
    first.unmount();

    markStepUpReturn(PATH);
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    await screen.findByRole("complementary", { name: "Record the QIO decision" });
    expect((screen.getByLabelText("Outcome") as HTMLSelectElement).value).toBe("other");
    expect((screen.getByLabelText(/^Date/) as HTMLInputElement).value).toBe("2026-01-10");
    expect((screen.getByLabelText(/^Time of day/) as HTMLInputElement).value).toBe("18:00");
    expect((screen.getByLabelText(/^Note/) as HTMLTextAreaElement).value).toBe(
      "QIO asked for more records",
    );
    expect(needs()).toBeNull();
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.recordReviewFacts).toHaveBeenLastCalledWith(
        "adm-1",
        expect.objectContaining({ id: "r-1" }),
        {
          decision: {
            outcome: "other",
            received: { date: "2026-01-10", time: "18:00" },
            note: "QIO asked for more records",
          },
        },
      ),
    );
  });

  it("withdraw review: a stale session goes to /step-up and the confirmation is back on return", async () => {
    const api = fakeApi(FULL);
    vi.mocked(api.withdrawReview).mockRejectedValueOnce(stepUpError());
    const first = renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw review" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdraw" }));
    await waitFor(() => expect(where()).toBe(`/step-up?returnTo=${returnTo}`));
    first.unmount();

    markStepUpReturn(PATH);
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    expect(
      await screen.findByRole("group", { name: "Confirm withdrawing the review" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdraw" }));
    await waitFor(() => expect(api.withdrawReview).toHaveBeenCalledTimes(2));
  });

  it("an abandoned step-up (no return marker) reopens nothing and the stale draft is discarded", async () => {
    const api = fakeApi(NOTICE_ONLY);
    vi.mocked(api.withdrawNotice).mockRejectedValueOnce(stepUpError());
    const first = renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    fill(/^Why is this record being withdrawn/, "free text that must not linger");
    fireEvent.click(save());
    await waitFor(() => expect(where()).toBe(`/step-up?returnTo=${returnTo}`));
    first.unmount();

    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    await screen.findByText("NOMNC and QIO review");
    expect(screen.queryByRole("complementary", { name: "Withdraw NOMNC record" })).toBeNull();
    await waitFor(() =>
      expect(peekStepUpDraft(stepUpDraftKey(OWNER, "m6-nomnc-withdraw-notice", "n-1"))).toBeNull(),
    );
  });

  it("closing the form clears its draft; a non-step-up failure shows the message and stashes nothing", async () => {
    const api = fakeApi(NOTICE_ONLY);
    vi.mocked(api.withdrawNotice).mockRejectedValueOnce(
      new NomncApiError("a reason is required", false),
    );
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    fill(/^Why is this record being withdrawn/, "typed");
    fireEvent.click(save());
    expect(await screen.findByText("a reason is required")).toBeTruthy();
    expect(where()).toBe(PATH);
    expect(peekStepUpDraft(stepUpDraftKey(OWNER, "m6-nomnc-withdraw-notice", "n-1"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("complementary", { name: "Withdraw NOMNC record" })).toBeNull();
  });
});

describe("NomncPromptStrip (discharge stepper)", () => {
  it("passes the chosen reason and renders the prompts, never blocking", async () => {
    const api = fakeApi(
      overview({
        prompts: [{ code: "NO_NOTICE", severity: "warn", message: "No NOMNC delivery recorded." }],
      }),
    );
    renderWith(<NomncPromptStrip admissionId="adm-1" dischargeReason="for_cause" api={api} />);
    expect(await screen.findByText("No NOMNC delivery recorded.")).toBeTruthy();
    expect(api.overview).toHaveBeenCalledWith("adm-1", "for_cause");
  });

  it("a failed check is visible (non-blocking warning), never silent", async () => {
    const api = fakeApi();
    vi.mocked(api.overview).mockRejectedValue(new Error("down"));
    renderWith(<NomncPromptStrip admissionId="adm-1" dischargeReason="for_cause" api={api} />);
    expect(await screen.findByText(/Could not check NOMNC status/)).toBeTruthy();
  });

  it("changing the reason reloads and drops the stale answer for the old reason", async () => {
    let resolveFirst: (o: NomncOverview) => void = () => undefined;
    const api = fakeApi();
    vi.mocked(api.overview).mockImplementation((_id, reason) =>
      reason === "for_cause"
        ? new Promise<NomncOverview>((r) => {
            resolveFirst = r;
          })
        : Promise.resolve(
            overview({
              prompts: [{ code: "X", severity: "info", message: "second reason prompt" }],
            }),
          ),
    );
    const { rerender } = renderWith(
      <NomncPromptStrip admissionId="adm-1" dischargeReason="for_cause" api={api} />,
    );
    rerender(
      wrap(
        <NomncPromptStrip admissionId="adm-1" dischargeReason="revocation" api={api} />,
        READ_RECORD,
      ),
    );
    expect(await screen.findByText("second reason prompt")).toBeTruthy();
    resolveFirst(
      overview({ prompts: [{ code: "Y", severity: "warn", message: "first reason prompt" }] }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("first reason prompt")).toBeNull();
  });

  it("renders nothing without nomnc.read", () => {
    const api = fakeApi();
    const { container } = renderWith(<NomncPromptStrip admissionId="adm-1" api={api} />, [
      "admission.read",
    ]);
    expect(container.textContent).toBe(PATH);
    expect(api.overview).not.toHaveBeenCalled();
  });
});
