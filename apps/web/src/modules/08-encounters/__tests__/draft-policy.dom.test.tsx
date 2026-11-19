// The tenant visit-note draft switch screen (ADR-0114 VN-D17): the effective setting with the phrase review's status and reviewer, the
// confirm step before turning it on, the 409 CORPUS_REVIEW_PENDING refusal in words, and the step-up round trip. Synthetic data only.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { markStepUpReturn, stepUpDraftKeys } from "../../../shell/step-up-redirect";
import { DraftPolicy } from "../draft-policy";
import { type Call, type Responder, mountScreen, refusal, writes } from "./closure-test-harness";

const PATH = "/admin/draft-policy";
const POLICY = "/api/v1/encounters/draft-policy";

const policyBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: false,
  reviewStatus: "approved",
  reviewer: "ADA",
  ...over,
});

interface Opts {
  read?: Responder;
  write?: Responder;
  calls?: Call[];
}

function mount(opts: Opts = {}): Call[] {
  const calls = opts.calls ?? [];
  mountScreen({
    calls,
    routePath: PATH,
    entry: PATH,
    permissions: ["encounter.draft_policy_admin"],
    element: <DraftPolicy />,
    routes: {
      [`GET ${POLICY}`]: opts.read ?? (() => ({ body: policyBody() })),
      [`PUT ${POLICY}`]:
        opts.write ?? ((call) => ({ body: policyBody(call.body as Record<string, unknown>) })),
    },
  });
  return calls;
}

const radio = (name: string): HTMLInputElement =>
  screen.getByRole("radio", { name }) as HTMLInputElement;
const save = (): HTMLElement => screen.getByRole("button", { name: "Save setting" });
const ready = (): Promise<unknown> => screen.findByRole("radio", { name: "Off" });
const inForce = (): HTMLElement =>
  screen.getByText("In force now").closest("section") as HTMLElement;

describe("reading the setting", () => {
  it("shows the effective setting, the review status and the reviewer, and the effect of each choice", async () => {
    mount();
    await ready();
    const panel = within(inForce());
    expect(panel.getByText("Off")).toBeInTheDocument();
    expect(panel.getByText("Approved")).toBeInTheDocument();
    expect(panel.getByText("ADA")).toBeInTheDocument();
    expect(radio("Off").checked).toBe(true);
    expect(
      screen.getByText(/must confirm or deselect every drafted section before signing/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing is pre-drafted/)).toBeInTheDocument();
  });

  it("says before the admin tries that the review is pending, and who is reviewing", async () => {
    mount({ read: () => ({ body: policyBody({ reviewStatus: "pending" }) }) });
    await ready();
    const panel = within(inForce());
    expect(panel.getByText("Pending")).toBeInTheDocument();
    expect(
      panel.getByText(
        /still in clinical review by ADA\. The server will not let the draft be turned on/,
      ),
    ).toBeInTheDocument();
  });

  it("shows an error with a retry, not a form of defaults, when the read fails", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mount({
      read: () => {
        attempts += 1;
        return attempts === 1 ? { status: 503, body: {} } : { body: policyBody() };
      },
    });
    expect(await screen.findByText("Visit-note draft setting unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
  });

  it("says it is not available, with no retry, to someone without access", async () => {
    mount({ read: refusal(403, "FORBIDDEN") });
    expect(await screen.findByText("Not available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says the switch is not available, not that it failed, when the server has no such screen (404)", async () => {
    mount({ read: refusal(404, "NOT_FOUND") });
    expect(await screen.findByText("Not available")).toBeInTheDocument();
    expect(screen.getByText(/setting is not available to your organization/i)).toBeInTheDocument();
    expect(screen.queryByText(/try again/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows an error, not a form, for an answer that does not say whether the draft is on", async () => {
    mount({ read: () => ({ body: { reviewStatus: "approved", reviewer: "ADA" } }) });
    expect(await screen.findByText("Visit-note draft setting unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("does not call a review status it does not know 'Pending'", async () => {
    mount({ read: () => ({ body: policyBody({ reviewStatus: "withdrawn" }) }) });
    await ready();
    const panel = within(inForce());
    expect(panel.queryByText("Pending")).toBeNull();
    expect(panel.queryByText("Approved")).toBeNull();
    expect(panel.getByText("Unknown")).toBeInTheDocument();
  });
});

describe("turning it on", () => {
  it("asks first, saying what changes for every clinician, and writes nothing until confirmed", async () => {
    const user = userEvent.setup();
    const calls = mount();
    await ready();
    expect(save()).toBeDisabled();

    await user.click(radio("On"));
    await user.click(save());
    expect(writes(calls)).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/cannot sign until each drafted section is confirmed or deselected/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/finalized before this was turned on cannot be signed/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/asked to confirm your identity first/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Turn on drafts" }));
    expect(
      await screen.findByText("Setting saved: the visit-note draft is on."),
    ).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(1);
    expect(writes(calls)[0]?.body).toEqual({ enabled: true });
    expect(within(inForce()).getByText("On")).toBeInTheDocument();
    // Focus lands on the panel that now shows what is in force.
    expect(screen.getByText("In force now")).toHaveFocus();
  });

  it("leaves the setting alone when the admin cancels", async () => {
    const user = userEvent.setup();
    const calls = mount();
    await ready();
    await user.click(radio("On"));
    await user.click(save());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(writes(calls)).toHaveLength(0);
    expect(screen.queryByText(/Setting saved/)).toBeNull();
  });

  it("explains a 409 CORPUS_REVIEW_PENDING refusal in words, keeps the choice and shows no success", async () => {
    const user = userEvent.setup();
    mount({ write: refusal(409, "CORPUS_REVIEW_PENDING") });
    await ready();
    await user.click(radio("On"));
    await user.click(save());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn on drafts",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/phrase wording has not completed its clinical review/);
    expect(alert).toHaveTextContent("Reviewer: ADA");
    expect(alert).toHaveTextContent(/Nothing was changed/);
    expect(screen.queryByText(/Setting saved/)).toBeNull();
    expect(radio("On").checked).toBe(true);
    expect(within(inForce()).getByText("Off")).toBeInTheDocument();
  });

  it("shows what the server holds now after a refresh that follows a refusal", async () => {
    const user = userEvent.setup();
    let reviewed = false;
    mount({
      read: () => ({ body: policyBody({ reviewStatus: reviewed ? "approved" : "pending" }) }),
      write: refusal(409, "CORPUS_REVIEW_PENDING"),
    });
    await ready();
    await user.click(radio("On"));
    await user.click(save());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn on drafts",
      }),
    );
    await screen.findByRole("alert");
    reviewed = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(within(inForce()).getByText("Approved")).toBeInTheDocument());
    expect(screen.queryByText(/phrase wording has not completed/)).toBeNull();
  });
});

describe("refreshing while a save is in flight", () => {
  it("cannot be done: the refresh waits, so an older read cannot put the old setting back over the saved one", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount({
      read: () => ({ body: policyBody({ enabled: true }) }),
      write: async (call) => {
        await held;
        return { body: policyBody(call.body as Record<string, unknown>) };
      },
    });
    await screen.findByRole("radio", { name: "On" });
    await user.click(radio("Off"));
    await user.click(save());
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled());
    release();
    expect(
      await screen.findByText("Setting saved: the visit-note draft is off."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(within(inForce()).getByText("Off")).toBeInTheDocument();
  });

  it("keeps the saved notice out of an inline style", async () => {
    const user = userEvent.setup();
    mount({ read: () => ({ body: policyBody({ enabled: true }) }) });
    await screen.findByRole("radio", { name: "On" });
    await user.click(radio("Off"));
    await user.click(save());
    await screen.findByText("Setting saved: the visit-note draft is off.");
    expect(within(inForce()).getByRole("status")).not.toHaveAttribute("style");
  });
});

describe("a save whose answer cannot be read", () => {
  it("shows no success, and says to refresh, instead of guessing the setting", async () => {
    const user = userEvent.setup();
    mount({ write: () => ({ body: { reviewStatus: "approved", reviewer: "ADA" } }) });
    await ready();
    await user.click(radio("On"));
    await user.click(save());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn on drafts",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/answer could not be read/);
    expect(screen.queryByText(/Setting saved/)).toBeNull();
    expect(within(inForce()).getByText("Off")).toBeInTheDocument();
  });
});

describe("turning it off", () => {
  it("saves at once, without a confirm step", async () => {
    const user = userEvent.setup();
    const calls = mount({ read: () => ({ body: policyBody({ enabled: true }) }) });
    await screen.findByRole("radio", { name: "On" });
    expect(radio("On").checked).toBe(true);
    await user.click(radio("Off"));
    await user.click(save());
    expect(
      await screen.findByText("Setting saved: the visit-note draft is off."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writes(calls)[0]?.body).toEqual({ enabled: false });
  });
});

describe("failures", () => {
  it("says it could not save, and shows no success, when the request gets no answer", async () => {
    const user = userEvent.setup();
    mount({
      read: () => ({ body: policyBody({ enabled: true }) }),
      write: () => {
        throw new Error("offline");
      },
    });
    await screen.findByRole("radio", { name: "On" });
    await user.click(radio("Off"));
    await user.click(save());
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
    expect(screen.queryByText(/Setting saved/)).toBeNull();
  });

  it("does not send twice when saved again while the first is in flight", async () => {
    const user = userEvent.setup();
    const calls = mount({
      read: () => ({ body: policyBody({ enabled: true }) }),
      write: (call) =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ body: policyBody(call.body as Record<string, unknown>) }), 20),
        ),
    });
    await screen.findByRole("radio", { name: "On" });
    await user.click(radio("Off"));
    const form = save().closest("form") as HTMLFormElement;
    form.requestSubmit();
    form.requestSubmit();
    await screen.findByText(/Setting saved/);
    expect(writes(calls)).toHaveLength(1);
  });
});

describe("step-up", () => {
  const stepUpRequired: Responder = () => ({
    status: 403,
    body: { error: { code: "STEP_UP_REQUIRED" } },
  });

  it("round-trips through step-up: the edit is restored on return and nothing is re-sent for the admin", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    let ceremonyDone = false;
    const write: Responder = (call) =>
      ceremonyDone
        ? { body: policyBody(call.body as Record<string, unknown>) }
        : stepUpRequired(call);
    mount({ calls, write });
    await ready();
    await user.click(radio("On"));
    await user.click(save());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn on drafts",
      }),
    );
    await screen.findByText("elsewhere");
    expect(document.body.dataset.where).toBe(`/step-up?returnTo=${encodeURIComponent(PATH)}`);
    expect(writes(calls)).toHaveLength(1);
    expect(stepUpDraftKeys().length).toBe(1);
    cleanup();

    ceremonyDone = true;
    markStepUpReturn(PATH);
    mount({ calls, write });
    await ready();
    expect(radio("On").checked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes(calls)).toHaveLength(1);
    await user.click(save());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn on drafts",
      }),
    );
    await screen.findByText("Setting saved: the visit-note draft is on.");
    expect(writes(calls)).toHaveLength(2);
    expect(stepUpDraftKeys().length).toBe(0);
  });

  it("discards an abandoned edit on an ordinary visit (no step-up return marker)", async () => {
    const user = userEvent.setup();
    mount({ write: stepUpRequired });
    await ready();
    await user.click(radio("On"));
    await user.click(save());
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Turn on drafts",
      }),
    );
    await screen.findByText("elsewhere");
    cleanup();

    mount();
    await ready();
    expect(radio("Off").checked).toBe(true);
    expect(stepUpDraftKeys().length).toBe(0);
  });
});

describe("accessibility", () => {
  it("has no axe violations and labels both choices with their effect", async () => {
    mount();
    await ready();
    expect(radio("On")).toHaveAccessibleDescription(
      /must confirm or deselect every drafted section/,
    );
    expect(radio("Off")).toHaveAccessibleDescription(/nothing is pre-drafted/);
    // The `region` rule (content outside a landmark) is the app shell's to satisfy, not this screen's: the harness has no shell.
    const results = await axe.run(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
