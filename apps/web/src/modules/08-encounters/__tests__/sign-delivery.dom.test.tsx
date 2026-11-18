// @vitest-environment jsdom
// The sign ceremony asks how the visit was delivered (Medicare hospice SIA and the visit lines count in-person
// visits only) and, only when no EVV bracket exists, for the ACTUAL documented start and end times. The server treats
// any `visitModality` in the sign body as the signer's explicit confirmation, so the UI must never pre-select or send
// a delivery mode the clinician did not actively choose, and must never default, fill in or alter a documented time.
//
// The device time zone is pinned BEFORE any Date is built so the instants the body carries can be asserted literally.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/New_York";

import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EncounterRead } from "../encounter-read";

// "Now" for the ceremony's "end cannot be in the future" rule: only Date is faked, timers stay real.
const NOW = new Date("2026-12-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});

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
  visitModality: null,
  visitModalityConfirmed: false,
  timeSource: null,
  evvBracketPresent: false,
};

const SIGN_PATH = "/api/v1/encounters/{encounterId}/sign";

type PostImpl = (path: string, init?: unknown) => Promise<unknown>;

const signed: PostImpl = async () => ({ data: { status: "signed" }, response: new Response() });
const unreachable: PostImpl = async () => {
  throw new TypeError("Failed to fetch");
};
const refused =
  (code: string, message: string): PostImpl =>
  async () => ({
    error: { error: { code, message } },
    response: new Response(null, { status: 422 }),
  });

function mountWith(encounter: Record<string, unknown>, postImpl: PostImpl = signed) {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
    if (path === "/api/v1/encounters/{encounterId}/cosignature") return { data: { status: null } };
    if (path === "/api/v1/patients/{id}") {
      return {
        data: {
          firstName: "Ava",
          lastName: "Stone",
          dob: "1950-01-01",
          mrn: "MRN1",
          status: "active",
        },
      };
    }
    if (path === "/api/v1/internal/care-plan/relevant-elements") {
      return { data: { problems: [], goals: [], interventions: [], redacted: false } };
    }
    return { data: { assessments: [] } };
  });
  const patch = vi.fn(async () => ({ data: {}, response: new Response() }));
  const post = vi.fn(postImpl);
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider client={{ GET: get, PATCH: patch, POST: post } as never}>
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
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

type User = ReturnType<typeof userEvent.setup>;

const openButton = () => screen.findByRole("button", { name: "Sign encounter" });

async function openSignCeremony(user: User) {
  await user.click(await openButton());
  return screen.findByRole("group", { name: /how was this visit delivered/i });
}

const attestBox = () => screen.getByRole("checkbox", { name: /complete and accurate/i });
const attest = (user: User) => user.click(attestBox());
const commitButton = () => screen.getByRole("button", { name: /sign & commit/i });
const cancelButton = () => screen.getByRole("button", { name: "Cancel" });
// The page repeats a failed action's message behind the ceremony, so the ceremony's own copy is found inside it.
const ceremony = () => within(screen.getByRole("dialog", { name: "Sign encounter" }));
const startInput = () => screen.getByLabelText(/start time/i);
const endInput = () => screen.getByLabelText(/end time/i);

/** Only the SIGN request: the shared client also serves other writes, which must not satisfy a wait. */
const signCalls = (post: ReturnType<typeof mountWith>["post"]) =>
  post.mock.calls.filter(([path]) => path === SIGN_PATH);

const waitForSign = (post: ReturnType<typeof mountWith>["post"]) =>
  waitFor(() => expect(signCalls(post)).toHaveLength(1));

function signBodyOf(post: ReturnType<typeof mountWith>["post"]): Record<string, unknown> {
  const call = signCalls(post)[0];
  if (!call) throw new Error("the sign request was never sent");
  return (call[1] as { body: Record<string, unknown> }).body;
}

const radiosOf = (group: HTMLElement) =>
  ["In person", "Telephonic", "Video"].map((name) => within(group).getByRole("radio", { name }));

describe("sign ceremony: how was this visit delivered?", () => {
  it("blocks signing until a modality is chosen, then sends the explicit choice", async () => {
    const user = userEvent.setup();
    const { post } = mountWith(finalizedRn);
    const group = await openSignCeremony(user);

    for (const radio of radiosOf(group)) expect(radio).not.toBeChecked();
    await attest(user);
    expect(commitButton()).toBeDisabled();

    await user.click(within(group).getByRole("radio", { name: "In person" }));
    expect(commitButton()).toBeEnabled();
    await user.click(commitButton());

    await waitForSign(post);
    expect(signBodyOf(post)).toEqual({ attestationConfirmed: true, visitModality: "in_person" });
  });

  it("does not pre-select an unconfirmed scheduled modality: it is a hint, and signing waits for a click", async () => {
    const user = userEvent.setup();
    const { post } = mountWith({
      ...finalizedRn,
      visitModality: "in_person",
      visitModalityConfirmed: false,
    });
    const group = await openSignCeremony(user);

    for (const radio of radiosOf(group)) expect(radio).not.toBeChecked();
    expect(screen.getByText(/Scheduled as: In person \(not yet confirmed\)/)).toBeVisible();
    await attest(user);
    expect(commitButton()).toBeDisabled();

    // Choosing the very mode it was scheduled as is still the clinician's own, active confirmation.
    await user.click(within(group).getByRole("radio", { name: "In person" }));
    expect(commitButton()).toBeEnabled();
    await user.click(commitButton());

    await waitForSign(post);
    expect(signBodyOf(post)).toEqual({ attestationConfirmed: true, visitModality: "in_person" });
  });

  it("treats a modality with no confirmed flag as unconfirmed", async () => {
    const user = userEvent.setup();
    const { visitModalityConfirmed: _omitted, ...withoutFlag } = finalizedRn;
    mountWith({ ...withoutFlag, visitModality: "telephonic" });
    const group = await openSignCeremony(user);

    for (const radio of radiosOf(group)) expect(radio).not.toBeChecked();
    await attest(user);
    expect(commitButton()).toBeDisabled();
  });

  it("opens a modality a clinician already confirmed as selected, with no hint", async () => {
    const user = userEvent.setup();
    const { post } = mountWith({
      ...finalizedRn,
      visitModality: "telephonic",
      visitModalityConfirmed: true,
    });
    const group = await openSignCeremony(user);

    expect(within(group).getByRole("radio", { name: "Telephonic" })).toBeChecked();
    expect(screen.queryByText(/Scheduled as/)).toBeNull();
    await attest(user);
    expect(commitButton()).toBeEnabled();
    await user.click(commitButton());

    await waitForSign(post);
    expect(signBodyOf(post).visitModality).toBe("telephonic");
  });

  it("lets the clinician change a scheduled modality", async () => {
    const user = userEvent.setup();
    const { post } = mountWith({ ...finalizedRn, visitModality: "in_person" });
    const group = await openSignCeremony(user);

    await user.click(within(group).getByRole("radio", { name: "Video" }));
    await attest(user);
    await user.click(commitButton());

    await waitForSign(post);
    expect(signBodyOf(post).visitModality).toBe("video");
  });

  it("hides the time inputs when an EVV bracket exists and sends no times", async () => {
    const user = userEvent.setup();
    const { post } = mountWith({
      ...finalizedRn,
      visitModality: "in_person",
      visitModalityConfirmed: true,
      evvBracketPresent: true,
    });
    await openSignCeremony(user);

    expect(screen.queryByLabelText(/start time/i)).toBeNull();
    expect(screen.queryByLabelText(/end time/i)).toBeNull();
    expect(screen.getByText(/electronic visit verification/i)).toBeTruthy();

    await attest(user);
    await user.click(commitButton());
    await waitForSign(post);
    const body = signBodyOf(post);
    expect(body).not.toHaveProperty("startedAt");
    expect(body).not.toHaveProperty("endedAt");
  });

  it("does not ask a physician for a modality", async () => {
    const user = userEvent.setup();
    const { post } = mountWith({
      ...finalizedRn,
      discipline: "md",
      encounterType: "face_to_face",
      visitModality: "in_person",
    });
    await user.click(await openButton());

    expect(screen.queryByRole("group", { name: /how was this visit delivered/i })).toBeNull();
    await attest(user);
    await user.click(commitButton());
    await waitForSign(post);
    expect(signBodyOf(post)).not.toHaveProperty("visitModality");
  });
});

describe("sign ceremony: documented visit times", () => {
  async function openWithChosenModality(user: User, postImpl?: PostImpl) {
    const mounted = mountWith({ ...finalizedRn, visitModality: "in_person" }, postImpl);
    const group = await openSignCeremony(user);
    await user.click(within(group).getByRole("radio", { name: "In person" }));
    return mounted;
  }

  it("shows optional time inputs with plain guidance and the device time zone, and sends no time that was not typed", async () => {
    const user = userEvent.setup();
    const { post } = await openWithChosenModality(user);

    expect(startInput()).toHaveValue("");
    expect(endInput()).toHaveValue("");
    expect(screen.getByText(/actual .*times/i)).toBeTruthy();
    expect(screen.getByText(/America\/New_York/)).toBeTruthy();

    await attest(user);
    await user.click(commitButton());
    await waitForSign(post);
    const untouched = signBodyOf(post);
    expect(untouched).not.toHaveProperty("startedAt");
    expect(untouched).not.toHaveProperty("endedAt");
  });

  it("sends the typed start and end as the exact instants of the device-zone wall clock", async () => {
    const user = userEvent.setup();
    const { post } = await openWithChosenModality(user);

    await user.type(startInput(), "2026-08-31T10:00");
    await user.type(endInput(), "2026-08-31T10:50");
    await attest(user);
    await user.click(commitButton());

    await waitForSign(post);
    expect(signBodyOf(post)).toEqual({
      attestationConfirmed: true,
      visitModality: "in_person",
      startedAt: "2026-08-31T14:00:00.000Z",
      endedAt: "2026-08-31T14:50:00.000Z",
    });
  });

  it("holds back a half-entered pair, and explains it only once focus has LEFT the pair", async () => {
    const user = userEvent.setup();
    await openWithChosenModality(user);

    await user.type(startInput(), "2026-08-31T10:00");
    expect(screen.queryByText(/both the start and end time/i)).toBeNull();
    expect(startInput()).not.toHaveAttribute("aria-invalid");

    // Tab from the start field to the end field: the clinician is still filling in the pair, so no alert interrupts.
    await user.tab();
    expect(endInput()).toHaveFocus();
    expect(screen.queryByText(/both the start and end time/i)).toBeNull();
    expect(startInput()).not.toHaveAttribute("aria-invalid");

    // Tab out of the pair with the end still empty: now it is a half-entered pair.
    await user.tab();
    expect(screen.getByText(/both the start and end time/i)).toBeVisible();
    expect(startInput()).toHaveAttribute("aria-invalid", "true");
    await attest(user);
    expect(commitButton()).toBeDisabled();
  });

  it("does not count tabbing through two empty time fields as touching them", async () => {
    const user = userEvent.setup();
    await openWithChosenModality(user);

    await user.click(startInput());
    await user.tab(); // start -> end
    await user.tab(); // out of the pair, nothing typed
    await user.type(startInput(), "2026-08-31T10:00");

    expect(screen.queryByText(/both the start and end time/i)).toBeNull();
  });

  it("blocks a second commit while the first request is in flight, yet never traps the clinician: Cancel stays available", async () => {
    const user = userEvent.setup();
    let settle: () => void = () => undefined;
    const hanging: PostImpl = () =>
      new Promise((resolve) => {
        settle = () => resolve({ data: { status: "signed" }, response: new Response() });
      });
    const { post } = await openWithChosenModality(user, hanging);
    await attest(user);
    await user.click(commitButton());
    await waitForSign(post);

    const inFlight = ceremony().getByRole("button", { name: /signing…/i });
    expect(inFlight).toBeDisabled();
    expect(cancelButton()).toBeEnabled();
    await user.click(inFlight);
    expect(post.mock.calls.filter(([path]) => path === SIGN_PATH)).toHaveLength(1);

    settle();
  });

  it("blocks an end before the start, with its message", async () => {
    const user = userEvent.setup();
    await openWithChosenModality(user);

    await user.type(startInput(), "2026-08-31T10:50");
    await user.type(endInput(), "2026-08-31T10:00");
    await attest(user);

    expect(screen.getByText("The end time must be after the start time.")).toBeVisible();
    expect(commitButton()).toBeDisabled();
  });

  it("blocks an end time in the future", async () => {
    const user = userEvent.setup();
    await openWithChosenModality(user);

    // NOW is 2026-12-01T00:00Z, i.e. 2026-11-30 19:00 in New York.
    await user.type(startInput(), "2026-12-01T10:00");
    await user.type(endInput(), "2026-12-01T10:50");
    await attest(user);

    expect(screen.getByText("The end time cannot be in the future.")).toBeVisible();
    expect(commitButton()).toBeDisabled();
  });

  it("refuses a time the clocks skip on the spring-forward night instead of moving it", async () => {
    const user = userEvent.setup();
    await openWithChosenModality(user);

    await user.type(startInput(), "2026-03-08T02:30");
    await user.type(endInput(), "2026-03-08T03:30");
    await attest(user);

    expect(screen.getByText(/daylight-saving/i)).toBeVisible();
    expect(commitButton()).toBeDisabled();
  });

  it("maps a server time rejection to the server's own message", async () => {
    const user = userEvent.setup();
    await openWithChosenModality(
      user,
      refused("VISIT_TIME_INVALID", "The visit ends before the patient was admitted."),
    );

    await attest(user);
    await user.click(commitButton());

    expect(
      await ceremony().findByText("The visit ends before the patient was admitted."),
    ).toBeVisible();
  });
});

describe("sign ceremony: leaving, failing and retrying", () => {
  it("lets a clinician who is unsure cancel while the delivery step is incomplete", async () => {
    const user = userEvent.setup();
    const { post } = mountWith({ ...finalizedRn, visitModality: "in_person" });
    await openSignCeremony(user);
    await attest(user);

    expect(commitButton()).toBeDisabled();
    expect(cancelButton()).toBeEnabled();
    await user.click(cancelButton());

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /how was this visit delivered/i })).toBeNull(),
    );
    expect(signCalls(post)).toHaveLength(0);
  });

  it("asks for the attestation and the delivery choice afresh when the ceremony is reopened", async () => {
    const user = userEvent.setup();
    mountWith({ ...finalizedRn, visitModality: "in_person" });
    const group = await openSignCeremony(user);
    await user.click(within(group).getByRole("radio", { name: "Video" }));
    await attest(user);
    expect(attestBox()).toBeChecked();

    await user.click(cancelButton());
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /how was this visit delivered/i })).toBeNull(),
    );
    const reopened = await openSignCeremony(user);

    expect(attestBox()).not.toBeChecked();
    for (const radio of radiosOf(reopened)) expect(radio).not.toBeChecked();
    expect(commitButton()).toBeDisabled();
  });

  it("recovers from an unreachable server: busy clears, the failure is said, Cancel and retry still work", async () => {
    const user = userEvent.setup();
    const { post } = mountWith({ ...finalizedRn, visitModality: "in_person" }, unreachable);
    const group = await openSignCeremony(user);
    await user.click(within(group).getByRole("radio", { name: "In person" }));
    await attest(user);
    await user.click(commitButton());

    const failure = await ceremony().findByText(/could not reach the server/i);
    expect(failure).toBeVisible();
    await waitFor(() => expect(failure).toHaveFocus());
    expect(signCalls(post)).toHaveLength(1);
    // "Signing…" is gone: the button reads "Sign & commit" again, and both buttons are live.
    expect(commitButton()).toBeEnabled();
    expect(cancelButton()).toBeEnabled();

    await user.click(commitButton());
    await waitFor(() => expect(signCalls(post)).toHaveLength(2));
  });

  it("maps a missing delivery-mode confirmation to plain words and puts focus on them", async () => {
    const user = userEvent.setup();
    mountWith(
      { ...finalizedRn, visitModality: "in_person" },
      refused("MODALITY_CONFIRMATION_REQUIRED", "visitModality is required for this discipline"),
    );
    const group = await openSignCeremony(user);
    await user.click(within(group).getByRole("radio", { name: "In person" }));
    await attest(user);
    await user.click(commitButton());

    const message = await ceremony().findByText(
      "Choose how this visit was delivered, then sign again.",
    );
    expect(message).toBeVisible();
    await waitFor(() => expect(message).toHaveFocus());
    expect(screen.queryByText(/visitModality is required/)).toBeNull();
    expect(cancelButton()).toBeEnabled();
  });

  it("explains a delivery mode the visit type cannot have, in words rather than the generic failure", async () => {
    const user = userEvent.setup();
    mountWith(
      { ...finalizedRn, encounterType: "telephonic" },
      refused("MODALITY_CONFLICTS_WITH_VISIT_TYPE", "a telephonic visit type cannot be in_person"),
    );
    const group = await openSignCeremony(user);
    await user.click(within(group).getByRole("radio", { name: "In person" }));
    await attest(user);
    await user.click(commitButton());

    const message = await ceremony().findByText(/telephonic visit type, so it cannot be recorded/i);
    expect(message).toBeVisible();
    expect(ceremony().queryByText("The action could not be completed.")).toBeNull();
    expect(cancelButton()).toBeEnabled();
  });

  it.each([
    [
      "VISIT_TIME_OVERLAP",
      "these visit times overlap another visit you documented",
      /overlap another visit you documented/i,
    ],
    [
      "EVV_BRACKET_UNAVAILABLE",
      "the visit's check-in/check-out record could not be reached",
      /check-in\/check-out record could not be reached/i,
    ],
  ])(
    "says what to do when the server answers %s, not the generic failure",
    async (code, serverMessage, shown) => {
      const user = userEvent.setup();
      mountWith(finalizedRn, refused(code, serverMessage));
      const group = await openSignCeremony(user);
      await user.click(within(group).getByRole("radio", { name: "In person" }));
      await attest(user);
      await user.click(commitButton());

      const message = await ceremony().findByText(shown);
      expect(message).toBeVisible();
      expect(ceremony().queryByText("The action could not be completed.")).toBeNull();
      expect(cancelButton()).toBeEnabled();
    },
  );
});
