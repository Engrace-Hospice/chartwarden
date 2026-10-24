// @vitest-environment jsdom
// Milestone 10a — the NOMNC / QIO review panel: loud prompts for what is missing, deadlines shown exactly as typed
// with a minute-accurate countdown, drawer forms with NO prefilled date or time, and the pure formatters.
// Fixtures are synthetic (no real patient names).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import type { NomncApi, NomncOverview, NoticeView } from "../nomnc-api";
import { countdownLabel, formatInZone, nextOpenDeadline, typedEcho } from "../nomnc-format";
import { NomncPanel, NomncPromptStrip } from "../nomnc-panel";

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

function fakeApi(ov: NomncOverview): NomncApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    overview: vi.fn(async () => ov),
    recordNotice: vi.fn(async () => notice()),
    setAcknowledgement: vi.fn(async () => notice()),
    withdrawNotice: vi.fn(async () => notice()),
    openReview: vi.fn(),
    recordReviewFacts: vi.fn(),
    withdrawReview: vi.fn(),
    addNoticeDeadline: vi.fn(),
    addReviewDeadline: vi.fn(),
    editDeadline: vi.fn(async () => ({})),
  } as unknown as NomncApi & Record<string, ReturnType<typeof vi.fn>>;
}

function renderWith(ui: JSX.Element, permissions = ["nomnc.read", "nomnc.record"]) {
  return render(
    <ApiClientProvider client={{} as ApiClient}>
      <SessionProvider session={session(permissions)}>{ui}</SessionProvider>
    </ApiClientProvider>,
  );
}

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

  it("echoes exactly what was typed", () => {
    expect(typedEcho("2026-01-12T12:00", "America/New_York")).toBe(
      "2026-01-12 12:00 (America/New_York)",
    );
  });

  it("picks the soonest unsatisfied deadline", () => {
    const rows = [
      { dueAt: "2026-01-13T00:00:00.000Z", satisfiedAt: null },
      { dueAt: "2026-01-11T00:00:00.000Z", satisfiedAt: "2026-01-10T00:00:00.000Z" },
      { dueAt: "2026-01-12T00:00:00.000Z", satisfiedAt: null },
    ];
    expect(nextOpenDeadline(rows)?.dueAt).toBe("2026-01-12T00:00:00.000Z");
    expect(nextOpenDeadline([])).toBeNull();
  });
});

describe("NomncPanel", () => {
  it("with no record: says so and offers to record, with no deadline invented", async () => {
    renderWith(<NomncPanel admissionId="adm-1" api={fakeApi(overview())} />);
    expect(await screen.findByText("No NOMNC delivery recorded for this admission.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record NOMNC delivery" })).toBeTruthy();
  });

  it("shows the loud prompts and the 'not a computed CMS time' label", async () => {
    const ov = overview({
      activeNotice: notice(),
      prompts: [
        { code: "NO_APPEAL_DEADLINE", severity: "warn", message: "No deadline recorded: enter it from the notice." },
        { code: "NO_ACKNOWLEDGEMENT", severity: "info", message: "Signature or refusal not recorded." },
      ],
    });
    renderWith(<NomncPanel admissionId="adm-1" api={fakeApi(ov)} />);
    expect((await screen.findAllByText("No deadline recorded: enter it from the notice.")).length).toBeGreaterThan(0);
    expect(screen.getByText("Signature or refusal not recorded.")).toBeTruthy();
    expect(screen.getByText(/from your notice or the QIO's call, not a computed CMS time/)).toBeTruthy();
  });

  it("shows a typed deadline exactly as typed, with its source, and a Mark met action", async () => {
    const ov = overview({
      activeNotice: notice({ acknowledgementKind: "signed" }),
      deadlines: [
        {
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
        },
      ],
    });
    const api = fakeApi(ov);
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    expect(await screen.findByText("2099-01-12 12:00 (America/New_York)")).toBeTruthy();
    expect(screen.getByText("printed on the NOMNC, line 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark Appeal request deadline met" }));
    await waitFor(() =>
      expect(api.editDeadline).toHaveBeenCalledWith("adm-1", expect.objectContaining({ id: "d-1" }), {
        satisfy: true,
      }),
    );
  });

  it("the record form starts EMPTY: no date, no time; Save stays disabled until time and source are typed", async () => {
    const api = fakeApi(overview());
    renderWith(<NomncPanel admissionId="adm-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record NOMNC delivery" }));
    const date = screen.getByLabelText(/^Date/) as HTMLInputElement;
    const time = screen.getByLabelText(/^Time of day/) as HTMLInputElement;
    expect(date.value).toBe("");
    expect(time.value).toBe("");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^Last day of services/), { target: { value: "2026-01-14" } });
    fireEvent.change(date, { target: { value: "2026-01-10" } });
    expect(save.disabled).toBe(true); // a date without a time is not submittable
    fireEvent.change(time, { target: { value: "10:30" } });
    expect(save.disabled).toBe(true); // and a source note is mandatory
    fireEvent.change(screen.getByLabelText(/^Where this came from/), { target: { value: "signed copy" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
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
  });

  it("a reader without nomnc.record sees the facts but no record actions", async () => {
    const api = fakeApi(overview({ activeNotice: notice() }));
    renderWith(<NomncPanel admissionId="adm-1" api={api} />, ["nomnc.read"]);
    expect(await screen.findByText("NOMNC and QIO review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open QIO review" })).toBeNull();
  });

  it("without nomnc.read nothing renders and nothing is fetched", () => {
    const api = fakeApi(overview());
    const { container } = renderWith(<NomncPanel admissionId="adm-1" api={api} />, ["admission.read"]);
    expect(container.textContent).toBe("");
    expect(api.overview).not.toHaveBeenCalled();
  });
});

describe("NomncPromptStrip (discharge stepper)", () => {
  it("passes the chosen reason and renders the prompts, never blocking", async () => {
    const api = fakeApi(
      overview({ prompts: [{ code: "NO_NOTICE", severity: "warn", message: "No NOMNC delivery recorded." }] }),
    );
    renderWith(<NomncPromptStrip admissionId="adm-1" dischargeReason="for_cause" api={api} />);
    expect(await screen.findByText("No NOMNC delivery recorded.")).toBeTruthy();
    expect(api.overview).toHaveBeenCalledWith("adm-1", "for_cause");
  });
});
