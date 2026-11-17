// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS } from "../hope-api";
import { withoutConflictErrors } from "../hope-save-status";
import {
  SESSION,
  SIGNED,
  assessment,
  clientFor,
  ok,
  renderWorkspace,
  workspace,
} from "./workspace-test-kit";

// What the assessment screen says after a stale-version refusal, what it offers when its workspace could not be read, and
// that a request nobody answers ends instead of holding the page (the autosave, the load, the signer lookup).

type Mocked = ReturnType<typeof vi.fn>;
const asMock = (fn: unknown) => fn as Mocked;
const reply = (status: number, error?: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});
const never = () => new Promise<never>(() => undefined);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const huvWorkspace = (version?: number) => {
  const base = workspace();
  return {
    ...base,
    assessment: {
      ...base.assessment,
      isc: "HUV",
      rfaKind: "02_huv1",
      ...(version === undefined ? {} : { version }),
    },
  };
};
const HUV = { ...assessment, rfaKind: "02_huv1" };

const RELOAD_INSTRUCTION = /Reload the latest version before continuing/;
const reloadButton = () => screen.queryByRole("button", { name: "Reload assessment" });
const LOADING = "Loading HOPE workspace...";

/** Presses Reload assessment and waits for the page to come back from its spinner (what it shows then is what counts). */
async function reloadAndWait(): Promise<void> {
  fireEvent.click(reloadButton() as HTMLElement);
  expect(screen.queryAllByLabelText(LOADING).length).toBeGreaterThan(0);
  await waitFor(() => expect(screen.queryAllByLabelText(LOADING)).toHaveLength(0));
}

/** A client whose workspace read answers as `workspaceRead()` says (the default answers as the kit does). */
function clientWithWorkspaceRead(workspaceRead: () => Promise<unknown>, over = {}) {
  const client = clientFor(over);
  const get = asMock(client.GET);
  const initial = get.getMockImplementation() as (path: string, init?: unknown) => Promise<unknown>;
  get.mockImplementation(async (path: string, init?: unknown) =>
    path.includes("/workspace") ? workspaceRead() : initial(path, init),
  );
  return client;
}

describe("a HUV completion date refused as stale, and the page re-reading itself", () => {
  async function confirmDate(client: ReturnType<typeof clientFor>) {
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
    fireEvent.change(await screen.findByLabelText("Assessment completed on"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm date" }));
  }
  const conflict = () =>
    reply(409, { error: { code: "M10_VERSION_CONFLICT", message: "Changed." } });

  it("says the page was reloaded, not that it must be, once the re-read succeeded", async () => {
    const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
    asMock(client.PATCH).mockImplementationOnce(async () => conflict());

    await confirmDate(client);

    expect(await screen.findByText(/changed elsewhere and has been reloaded/)).toBeTruthy();
    expect(screen.queryByText(RELOAD_INSTRUCTION)).toBeNull();
    expect(reloadButton()).toBeNull();
    expect(screen.queryByText("Reload needed")).toBeNull();
  });

  it("keeps asking for a reload when the re-read could not be read, until Reload assessment succeeds", async () => {
    let workspaceReadable = true;
    const client = clientWithWorkspaceRead(
      async () => (workspaceReadable ? ok(huvWorkspace()) : reply(502)),
      { assessment: HUV },
    );
    asMock(client.PATCH).mockImplementationOnce(async () => {
      workspaceReadable = false; // the re-read that follows the refusal gets a gateway error
      return conflict();
    });

    await confirmDate(client);

    expect(await screen.findByText(RELOAD_INSTRUCTION)).toBeTruthy();
    expect(screen.queryByText(/has been reloaded/)).toBeNull();
    workspaceReadable = true;
    await reloadAndWait();

    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    expect(reloadButton()).toBeNull();
    expect(screen.queryByText("Reload needed")).toBeNull();
  });

  it("drops an item's own reload message too, when the page re-reads itself", async () => {
    const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
    asMock(client.PATCH).mockImplementation(async (path: string) =>
      path.endsWith("/answers")
        ? reply(409, { error: { code: "CONFLICT", message: "HOPE assessment version is stale" } })
        : conflict(),
    );
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));
    await waitFor(() => expect(screen.getAllByText(RELOAD_INSTRUCTION)).toHaveLength(2)); // banner + item

    // A later refusal (the completion date) makes the page re-read itself; that re-read is what must end both messages.
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    fireEvent.change(await screen.findByLabelText("Assessment completed on"), {
      target: { value: "2026-09-10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm date" }));
    await screen.findByText(/has been reloaded/);
    fireEvent.click(screen.getAllByRole("button", { name: /F Preferences/ })[0] as HTMLElement);

    expect(await screen.findByLabelText("Yes, discussion occurred")).toBeTruthy();
    expect(screen.queryAllByText(RELOAD_INSTRUCTION)).toHaveLength(0);
  });

  it("ends the notice with the next successful save", async () => {
    const client = clientFor({ assessment: HUV, workspace: huvWorkspace() });
    asMock(client.PATCH)
      .mockImplementationOnce(async () => conflict())
      .mockResolvedValueOnce(ok({ assessmentId: "hope-1", z0350: "2026-09-10" }));
    await confirmDate(client);
    await screen.findByText(/has been reloaded/);

    const confirm = (await screen.findByRole("button", {
      name: "Confirm date",
    })) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByText(/changed elsewhere/)).toBeNull());
  });
});

describe("an answer refused as stale, then the clinician reloads", () => {
  it("clears the banner and the item's reload message once the reload succeeded", async () => {
    renderWorkspace(clientFor({ patchError: "version is stale" }));
    await screen.findByRole("heading", { name: "Admission Workspace" });
    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));
    await waitFor(() => expect(screen.getAllByText(RELOAD_INSTRUCTION).length).toBe(2)); // banner + item

    await reloadAndWait();

    expect(screen.queryAllByText(RELOAD_INSTRUCTION)).toHaveLength(0);
    expect(reloadButton()).toBeNull();
    expect(screen.queryByText("Reload needed")).toBeNull();
  });

  it("only drops the reload messages, never another item's refusal", () => {
    const errors = {
      A: "This assessment changed elsewhere. Reload the latest version before continuing.",
      B: "This answer was not saved. Check the value and try again.",
    };

    expect(withoutConflictErrors(errors)).toEqual({ B: errors.B });
    const untouched = { B: errors.B };
    expect(withoutConflictErrors(untouched)).toBe(untouched);
  });
});

describe("a workspace that could not be read on first load", () => {
  it("offers Try again, and the retry shows the workspace", async () => {
    let workspaceReads = 0;
    renderWorkspace(
      clientWithWorkspaceRead(async () => (++workspaceReads === 1 ? reply(502) : ok(workspace()))),
    );

    expect(await screen.findByText("Workspace unavailable")).toBeTruthy();
    expect(screen.getByText(/could not be loaded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Admission Workspace" })).toBeTruthy();
    expect(screen.queryByText("Workspace unavailable")).toBeNull();
    expect(workspaceReads).toBe(2);
  });

  it("moves focus back to the failure when the retry fails too", async () => {
    let workspaceReads = 0;
    renderWorkspace(
      clientWithWorkspaceRead(async () => {
        workspaceReads += 1;
        return reply(502);
      }),
    );
    await screen.findByText("Workspace unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(workspaceReads).toBe(2));
    await waitFor(() => {
      const region = screen.getByText("Workspace unavailable").closest("[tabindex='-1']");
      expect(document.activeElement).toBe(region);
    });
  });
});

describe("requests nobody answers", () => {
  /** Lets REQUEST_TIMEOUT_MS pass with fake timers on, then puts real ones back. */
  async function afterTheWait(action: () => void): Promise<void> {
    vi.useFakeTimers();
    try {
      action();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("ends an answer save as Save not confirmed, and lets the next one go", async () => {
    const client = clientFor();
    asMock(client.PATCH).mockImplementationOnce(never);
    renderWorkspace(client);
    await screen.findByRole("heading", { name: "Admission Workspace" });
    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));

    await afterTheWait(() => fireEvent.click(screen.getByLabelText("Yes, discussion occurred")));

    // Nobody answered, so the save may have been applied: never "failed".
    expect(screen.getByText("Save not confirmed")).toBeTruthy();
    expect(screen.queryByText("Save failed")).toBeNull();
    fireEvent.click(screen.getByLabelText("No"));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(2));
  });

  it("ends the first load as the error state with Try again, not a spinner that never stops", async () => {
    let assessmentReads = 0;
    const client = clientFor();
    const get = asMock(client.GET);
    const initial = get.getMockImplementation() as (
      path: string,
      init?: unknown,
    ) => Promise<unknown>;
    get.mockImplementation(async (path: string, init?: unknown) =>
      path === "/api/v1/hope/assessments/{id}" && ++assessmentReads === 1
        ? never()
        : initial(path, init),
    );

    await afterTheWait(() => renderWorkspace(client));

    expect(screen.getByText("Could not load this HOPE assessment.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Admission Workspace" })).toBeTruthy();
  });
});

describe("the signer's name on a completed record", () => {
  it("does not reject unhandled when the lookup behind it is rejected", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = clientFor({ assessment: { ...SIGNED, signedBy: "member-7" } });
      const get = asMock(client.GET);
      const initial = get.getMockImplementation() as (
        path: string,
        init?: unknown,
      ) => Promise<unknown>;
      let patientReads = 0;
      get.mockImplementation(async (path: string, init?: unknown) => {
        // The first read is the screen's own; the second is the signer lookup, which is rejected.
        if (path === "/api/v1/patients/{id}" && ++patientReads === 2)
          throw new TypeError("offline");
        return initial(path, init);
      });

      renderWorkspace(client, SESSION);
      await waitFor(() => expect(patientReads).toBe(2));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(unhandled).toEqual([]);
      expect(screen.getByText(/Signed by the MD/)).toBeTruthy();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
