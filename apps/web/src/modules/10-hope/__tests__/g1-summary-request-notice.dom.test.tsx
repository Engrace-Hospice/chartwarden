// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION, SIGNED, clientFor, ok, renderWorkspace } from "./workspace-test-kit";

// Group g1 (web-k1 / web-k12): the assessment screen's "Request summary" says what happened. The request sends a fresh key every
// time, so a retry after an outcome nobody confirmed is a NEW request that can create a second summary: the words say to check the
// patient's documents first, and they stay on screen next to the button. The pressed button is disabled while the request is out
// (and stays so once it was requested), which drops focus to the document in Firefox and Safari: the words take it.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Mocked = ReturnType<typeof vi.fn>;
const asMock = (fn: unknown) => fn as Mocked;
const reply = (status: number, error?: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});

const UNCONFIRMED =
  "Could not confirm that the summary was requested. Check the patient's documents before trying again.";

const requestSummary = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Request summary" }));
};

function mount(answer: unknown) {
  const client = clientFor({ assessment: SIGNED });
  asMock(client.POST).mockImplementation(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  renderWorkspace(client, SESSION);
  return client;
}

describe("a summary request that was refused", () => {
  it.each([
    [403, "Your role may not request a summary."],
    [422, "The assessment has no summary template."],
  ])(
    "shows the server's words for a %s, focuses them, and keeps Retry enabled",
    async (status, words) => {
      mount(reply(status, { error: { code: "REFUSED", message: words } }));

      await requestSummary();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(words);
      await waitFor(() => expect(document.activeElement).toBe(alert));
      const retry = screen.getByRole("button", {
        name: "Retry summary request",
      }) as HTMLButtonElement;
      expect(retry.disabled).toBe(false);
    },
  );

  it("says the server gave no reason for a 4xx with no body", async () => {
    mount(reply(403));

    await requestSummary();

    expect((await screen.findByRole("alert")).textContent).toContain("without saying why");
  });
});

describe("a summary request whose outcome is not known", () => {
  it.each([
    ["is rejected", new TypeError("Failed to fetch")],
    ["answers 502 with no body", reply(502)],
    [
      "answers with an empty error body",
      { data: undefined, error: "", response: new Response(null, { status: 500 }) },
    ],
  ])("tells the clinician to check the documents first when it %s", async (_name, answer) => {
    mount(answer);

    await requestSummary();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(UNCONFIRMED);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByRole("button", { name: "Retry summary request" })).toBeTruthy();
  });

  it("keeps the warning up until the next attempt, and says a repeated outcome again (and takes focus again)", async () => {
    const client = mount(new TypeError("Failed to fetch"));
    await requestSummary();
    const first = await screen.findByRole("alert");
    expect(first.textContent).toBe(UNCONFIRMED);

    // The warning stays beside the button the clinician is about to press.
    expect(screen.getByRole("alert").textContent).toBe(UNCONFIRMED);

    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByRole("button", { name: "Retry summary request" }));
    await waitFor(() => expect(asMock(client.POST)).toHaveBeenCalledTimes(2));
    const second = await screen.findByRole("alert");
    expect(second.textContent).toBe(UNCONFIRMED);
    await waitFor(() => expect(document.activeElement).toBe(second));
  });
});

describe("a summary request that was accepted", () => {
  it("says so in a status, focuses it, and leaves the used button disabled", async () => {
    mount(ok({ assessmentId: "hope-1", requested: true }));

    await requestSummary();

    const status = await screen.findByText(
      /Summary requested\. It appears in the patient's documents/,
    );
    expect(status.getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(
      (screen.getByRole("button", { name: "Summary requested" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops the failure words once a retry is accepted", async () => {
    const client = mount(reply(403, { error: { code: "REFUSED", message: "Not now." } }));
    await requestSummary();
    await screen.findByRole("alert");

    asMock(client.POST).mockResolvedValueOnce(ok({ assessmentId: "hope-1", requested: true }));
    fireEvent.click(screen.getByRole("button", { name: "Retry summary request" }));

    await screen.findByText(/Summary requested\. It appears/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
