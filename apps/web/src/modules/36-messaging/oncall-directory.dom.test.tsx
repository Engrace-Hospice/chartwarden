// M36 WP 4.12 (ADR-0080) - the on-call directory screen: needs a patient team, loading, covering with times in the ROSTER's zone,
// an explicit coverage gap, "roster not connected" (unknown, never an empty list), not configured, denied/flag-off/error states,
// no write controls, no ids, the role switch re-reads, axe clean.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { OnCallCoverageDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnCallDirectory } from "./oncall-directory";
import {
  ONCALL_DENIED,
  ONCALL_GAP,
  ONCALL_LOAD_FAILED,
  ONCALL_NOT_CONFIGURED,
  ONCALL_NOT_CONNECTED,
  ONCALL_NO_PATIENT_TITLE,
  ONCALL_SHIFT_END_UNKNOWN,
  ONCALL_UNAVAILABLE,
  untilText,
} from "./oncall-directory-wording";

const PATH = "/api/v1/messaging/oncall/coverage";
const PATIENT = "99999999-9999-4999-8999-000000000001";
const ZONE = "America/Los_Angeles";

const coverage = (over: Partial<OnCallCoverageDto> = {}): OnCallCoverageDto => ({
  role: "rn",
  as_of: "2026-06-01T21:07:00.000Z",
  status: "covered",
  tiers: [
    {
      tier: 1,
      state: "covering",
      people: [
        { display_name: "Dana K.", rank: "primary" },
        { display_name: "Pat Q.", rank: "backup" },
      ],
      shift_ends_at: "2026-06-02T02:00:00.000Z",
      time_zone: ZONE,
    },
    {
      tier: 2,
      state: "covering",
      people: [{ display_name: null, rank: "primary" }],
      shift_ends_at: null,
      time_zone: ZONE,
    },
  ],
  ...over,
});

function mount(
  handler: (query: Record<string, unknown>) => unknown,
  search = `?patient=${PATIENT}`,
) {
  const GET = vi.fn((path: string, init?: { params?: { query?: Record<string, unknown> } }) => {
    expect(path).toBe(PATH);
    return Promise.resolve(handler(init?.params?.query ?? {}));
  });
  const POST = vi.fn();
  const PUT = vi.fn();
  const PATCH = vi.fn();
  const DELETE = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={[`/messaging/on-call${search}`]}>
      <ApiClientProvider client={{ GET, POST, PUT, PATCH, DELETE } as unknown as ApiClient}>
        <main>
          <OnCallDirectory />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, writes: [POST, PUT, PATCH, DELETE], ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OnCallDirectory", () => {
  it("asks for a patient's care team and makes no request without one", () => {
    const { GET } = mount(() => ({ data: coverage() }), "");
    expect(screen.getByText(ONCALL_NO_PATIENT_TITLE)).toBeTruthy();
    expect(GET).not.toHaveBeenCalled();
  });

  it("ignores a malformed patient id", () => {
    const { GET } = mount(() => ({ data: coverage() }), "?patient=not-a-uuid");
    expect(screen.getByText(ONCALL_NO_PATIENT_TITLE)).toBeTruthy();
    expect(GET).not.toHaveBeenCalled();
  });

  it("shows who covers, until when, in the roster's zone, and the backup's missing shift end in words", async () => {
    const { GET, writes } = mount(() => ({ data: coverage() }));
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement).getByText("Dana K. (Primary), Pat Q. (Backup)"),
    ).toBeTruthy();
    // 02:00Z on 2 June is 7:00 PM on 1 June in Los Angeles, the same day as 21:07Z (2:07 PM): no date shown
    expect(within(rows[0] as HTMLElement).getByText("until 7:00 PM PDT")).toBeTruthy();
    expect(screen.getByText(/as of 2:07 PM PDT \(America\/Los_Angeles\)/)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Name not available")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(ONCALL_SHIFT_END_UNKNOWN)).toBeTruthy();
    expect(GET.mock.calls[0]?.[1]).toEqual({
      params: { query: { role: "rn", patient_id: PATIENT } },
    });
    expect(screen.queryByRole("button")).toBeNull(); // no Message / Page / Urgent controls
    for (const w of writes) expect(w).not.toHaveBeenCalled();
  });

  it("states a coverage gap in words, never an empty list", async () => {
    mount(() => ({
      data: coverage({
        status: "coverage_gap",
        tiers: [
          { tier: 1, state: "coverage_gap", people: [], shift_ends_at: null, time_zone: ZONE },
        ],
      }),
    }));
    expect(await screen.findByText("Coverage gap")).toBeTruthy();
    expect(screen.getByText(ONCALL_GAP)).toBeTruthy();
  });

  it("says the roster is not connected (unknown) and not configured", async () => {
    const a = mount(() => ({ data: coverage({ status: "roster_not_connected", tiers: [] }) }));
    expect((await screen.findByRole("alert")).textContent).toBe(ONCALL_NOT_CONNECTED);
    expect(screen.queryByRole("list")).toBeNull();
    a.unmount();
    mount(() => ({ data: coverage({ status: "not_configured", tiers: [] }) }));
    expect((await screen.findByRole("alert")).textContent).toBe(ONCALL_NOT_CONFIGURED);
  });

  it("re-reads for the chosen role", async () => {
    const { GET } = mount((query) => ({
      data: coverage({ role: query.role as "rn" | "physician" }),
    }));
    await screen.findAllByRole("listitem");
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "physician" } });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(GET.mock.calls[1]?.[1]).toEqual({
      params: { query: { role: "physician", patient_id: PATIENT } },
    });
  });

  it("fails closed with no retry on 403 and says the feature is off on 404", async () => {
    const a = mount(() => ({ response: { status: 403 } }));
    expect((await screen.findByRole("alert")).textContent).toBe(ONCALL_DENIED);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    a.unmount();
    mount(() => ({ response: { status: 404 } }));
    expect((await screen.findByRole("alert")).textContent).toBe(ONCALL_UNAVAILABLE);
  });

  it("offers Retry on a failure", async () => {
    let calls = 0;
    mount(() => (++calls === 1 ? { response: { status: 500 } } : { data: coverage() }));
    expect(await screen.findByText(ONCALL_LOAD_FAILED)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
  });

  it("has no axe violations", async () => {
    const { container } = mount(() => ({ data: coverage() }));
    await screen.findAllByRole("listitem");
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

describe("untilText", () => {
  it("adds the date when the shift ends on another day in the roster's zone", () => {
    expect(untilText("2026-06-02T15:00:00.000Z", "2026-06-01T21:07:00.000Z", ZONE)).toBe(
      "until Jun 2, 8:00 AM PDT",
    );
  });

  it("follows the zone through the November fall-back", () => {
    // the clocks fall back at 09:00Z: 08:30Z is 1:30 AM PDT and 09:30Z is 1:30 AM PST, told apart by the abbreviation
    expect(untilText("2026-11-01T08:30:00.000Z", "2026-11-01T08:00:00.000Z", ZONE)).toBe(
      "until 1:30 AM PDT",
    );
    expect(untilText("2026-11-01T09:30:00.000Z", "2026-11-01T08:00:00.000Z", ZONE)).toBe(
      "until 1:30 AM PST",
    );
  });

  it("says the zone is unavailable instead of guessing", () => {
    expect(
      untilText("2026-06-02T02:00:00.000Z", "2026-06-01T21:07:00.000Z", "Not/AZone"),
    ).toContain("time zone unavailable");
  });
});
