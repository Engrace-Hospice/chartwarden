// @vitest-environment jsdom
// The cosigner's ceremony (acknowledge, sign with an attestation, supervisor release with a 40-character reason), written once and run for
// a note's request and for an amendment's (ADR-0114 VN-D30, S1 PR E4): the same steps, bodies, step-up and refusal sentences, only the route
// differs. Every refusal says what happened and the next step. Synthetic data only.
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosignCeremonyModals } from "../cosign-ceremony-modals";
import { type CosignSubject, useCosignCeremony } from "../use-cosign-ceremony";

afterEach(cleanup);

const NOTE: CosignSubject = { kind: "note", encounterId: "enc-1" };
const AMENDMENT: CosignSubject = { kind: "addendum", encounterId: "enc-1", addendumId: "add-1" };
const PATHS = {
  note: "/api/v1/encounters/{encounterId}/cosignature",
  addendum: "/api/v1/encounters/{encounterId}/addenda/{addendumId}/cosignature",
} as const;
const PATH_PARAMS = {
  note: { path: { encounterId: "enc-1" } },
  addendum: { path: { encounterId: "enc-1", addendumId: "add-1" } },
} as const;
const LONG_REASON =
  "The cosigner was on leave past the cap, so I am releasing this for the cover RN.";

function Harness({ subject, onDone }: { subject: CosignSubject; onDone: () => void }) {
  const ceremony = useCosignCeremony(subject, onDone);
  return (
    <>
      <button type="button" onClick={() => ceremony.open("acknowledge")}>
        Open acknowledge
      </button>
      <button type="button" onClick={() => ceremony.open("sign")}>
        Open sign
      </button>
      <button type="button" onClick={() => ceremony.open("release")}>
        Open release
      </button>
      <CosignCeremonyModals
        ceremony={ceremony}
        subject={subject.kind}
        heading={subject.kind === "note" ? "Cosign Routine Visit" : "Cosign amendment"}
        facts={[{ label: "Service date", value: "2026-11-15", mono: true }]}
      />
    </>
  );
}

function Location() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
function mount(subject: CosignSubject, reply: () => Promise<Reply> | Reply) {
  const POST = vi.fn(async () => reply());
  const onDone = vi.fn();
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider client={{ POST } as never}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Harness subject={subject} onDone={onDone} />
                <Location />
              </>
            }
          />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { POST, onDone, user: userEvent.setup() };
}

const ok = (): Reply => ({ data: { status: "acknowledged" }, response: { status: 200 } });
const refused = (status: number, code: string, message = "server text"): Reply => ({
  error: { error: { code, message } },
  response: { status },
});
const dialog = () => screen.getByRole("dialog");

describe.each([
  ["a note's request", NOTE],
  ["an amendment's request", AMENDMENT],
] as const)("the cosigner's ceremony on %s", (_name, subject) => {
  const base = `${PATHS[subject.kind]}`;
  const params = PATH_PARAMS[subject.kind];

  it("acknowledges with no body, closes, and tells the screen to read the request again", async () => {
    const { POST, onDone, user } = mount(subject, ok);
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    expect(within(dialog()).getByText(/does not sign it/i)).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith(`${base}/acknowledge`, { params });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("signs only after the attestation is ticked, sending the attestation and no identity", async () => {
    const { POST, onDone, user } = mount(subject, ok);
    await user.click(screen.getByRole("button", { name: "Open sign" }));
    const commit = within(dialog()).getByRole("button", { name: "Sign & commit" });
    expect(commit).toBeDisabled();
    await user.click(within(dialog()).getByRole("checkbox"));
    await user.click(commit);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith(`${base}/sign`, {
      params,
      body: { attestationConfirmed: true },
    });
    expect(JSON.stringify(POST.mock.calls)).not.toMatch(/author|signer|membership/i);
  });

  it("holds a release back until the reason has 40 characters, then sends it with a step-up time and an idempotency key", async () => {
    const { POST, onDone, user } = mount(subject, () => ({
      data: { status: "supervisor_released" },
      response: { status: 200 },
    }));
    await user.click(screen.getByRole("button", { name: "Open release" }));
    const reason = within(dialog()).getByRole("textbox", { name: /reason/i });
    await user.type(reason, "too short");
    await user.click(within(dialog()).getByRole("button", { name: "Release" }));
    expect(POST).not.toHaveBeenCalled();
    expect(within(dialog()).getByText("Provide a reason of at least 40 characters.")).toBeVisible();
    expect(reason).toBeInvalid();

    await user.clear(reason);
    await user.type(reason, LONG_REASON);
    await user.click(within(dialog()).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [path, init] = POST.mock.calls[0] as unknown as [
      string,
      { params: unknown; body: { reason: string; stepUpAuthAt: string }; headers: object },
    ];
    expect(path).toBe(`${base}/supervisor-release`);
    expect(init.params).toEqual(params);
    expect(init.body.reason).toBe(LONG_REASON);
    expect(Number.isNaN(Date.parse(init.body.stepUpAuthAt))).toBe(false);
    expect(init.headers).toEqual({ "Idempotency-Key": expect.any(String) });
  });

  it("says a request someone else moved on has moved on, and that nothing changed", async () => {
    const { user, onDone } = mount(subject, () => refused(409, "ILLEGAL_TRANSITION"));
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(/no longer waiting for this step/);
    expect(alert).toHaveTextContent(/Nothing was changed/);
    expect(alert).toHaveTextContent(/Reload the page/);
    expect(alert).not.toHaveTextContent("server text");
    expect(onDone).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole("button", { name: "Acknowledge" })).toBeEnabled();
  });

  it("says a request locked at the 48-hour cap needs a supervisor's release first", async () => {
    const { user } = mount(subject, () => refused(409, "COSIGNATURE_LOCKED"));
    await user.click(screen.getByRole("button", { name: "Open sign" }));
    await user.click(within(dialog()).getByRole("checkbox"));
    await user.click(within(dialog()).getByRole("button", { name: "Sign & commit" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(/locked at the 48-hour cap/);
    expect(alert).toHaveTextContent(/supervisor has to release it first/);
  });

  it("offers the real re-authentication screen when step-up is needed, and keeps the dialog open", async () => {
    const { user } = mount(subject, () => refused(403, "STEP_UP_REQUIRED"));
    await user.click(screen.getByRole("button", { name: "Open sign" }));
    await user.click(within(dialog()).getByRole("checkbox"));
    await user.click(within(dialog()).getByRole("button", { name: "Sign & commit" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(/needs a fresh re-authentication/);
    const link = within(dialog()).getByRole("link", { name: "Re-authenticate" });
    expect(link.getAttribute("href")).toBe(
      `/step-up?returnTo=${encodeURIComponent("/patients/patient-1/encounters/enc-1")}`,
    );
  });

  it("reads the machine's expired step-up (412) the same way", async () => {
    const { user } = mount(subject, () => refused(412, "STEP_UP_AUTH_REQUIRED"));
    await user.click(screen.getByRole("button", { name: "Open sign" }));
    await user.click(within(dialog()).getByRole("checkbox"));
    await user.click(within(dialog()).getByRole("button", { name: "Sign & commit" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(/re-authentication/);
    expect(within(dialog()).getByRole("link", { name: "Re-authenticate" })).toBeInTheDocument();
  });

  it("says who can act when the server answers 403, with no link to re-authenticate", async () => {
    const { user } = mount(subject, () => refused(403, "FORBIDDEN"));
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(/RN with cosign access who wrote neither/);
    expect(within(dialog()).queryByRole("link", { name: "Re-authenticate" })).toBeNull();
  });

  it("says a release by someone who is not a supervisor needs one", async () => {
    const { user } = mount(subject, () => refused(403, "SUPERVISOR_RELEASE_NOT_PERMITTED"));
    await user.click(screen.getByRole("button", { name: "Open release" }));
    await user.type(within(dialog()).getByRole("textbox", { name: /reason/i }), LONG_REASON);
    await user.click(within(dialog()).getByRole("button", { name: "Release" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(
      /clinical supervisor or the director of nursing/,
    );
  });

  it("says a request that cannot be found could not be found, and to reload", async () => {
    const { user } = mount(subject, () => refused(404, "NOT_FOUND"));
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(/could not be found/);
  });

  it("says a conflict it has no sentence for is a change made meanwhile", async () => {
    const { user } = mount(subject, () => refused(409, "STALE_VERSION"));
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(/changed while you were/);
  });

  it("takes a signed-out session to sign-in", async () => {
    const { user } = mount(subject, () => refused(401, "UNAUTHENTICATED"));
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent("/login"));
  });

  it("says the server could not be reached, and lets the cosigner try again", async () => {
    const { user, POST } = mount(subject, () => {
      throw new Error("offline");
    });
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(/Could not reach the server/);
    expect(within(dialog()).getByRole("button", { name: "Acknowledge" })).toBeEnabled();
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it("says what is being attested, by the note or by the amendment", async () => {
    const { user } = mount(subject, ok);
    await user.click(screen.getByRole("button", { name: "Open sign" }));
    expect(
      within(dialog()).getByText(
        subject.kind === "note" ? "Cosign Routine Visit" : "Cosign amendment",
      ),
    ).toBeInTheDocument();
    expect(within(dialog()).getByText("2026-11-15")).toBeInTheDocument();
    expect(
      within(dialog()).getByText(
        subject.kind === "note"
          ? /reviewed this documentation/
          : /reviewed this amendment to the signed documentation/,
      ),
    ).toBeInTheDocument();
  });

  it("has no axe violations with the release dialog open", async () => {
    const { user } = mount(subject, ok);
    await user.click(screen.getByRole("button", { name: "Open release" }));
    expect((await axe.run(dialog())).violations).toEqual([]);
  });

  it("clears the previous refusal when the ceremony is opened again", async () => {
    const { user } = mount(subject, () => refused(409, "ILLEGAL_TRANSITION"));
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    await user.click(within(dialog()).getByRole("button", { name: "Acknowledge" }));
    await within(dialog()).findByRole("alert");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open acknowledge" }));
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });
});
