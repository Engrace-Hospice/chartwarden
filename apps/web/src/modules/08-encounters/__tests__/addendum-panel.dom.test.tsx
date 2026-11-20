import { ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { AddendumRow } from "../addenda-api";
import { AddendaPanel } from "../addendum-panel";

const BASE = "/api/v1/encounters/{encounterId}/addenda/{addendumId}";

const draft: AddendumRow = {
  id: "add-1",
  status: "draft",
  reason: "Late-arriving family report of new pain pattern",
  authoredByUserId: "mem-author",
  createdAt: "2026-10-01T10:00:00Z",
  signedAt: null,
  version: 0,
};

const template = {
  encounterId: "enc-1",
  sections: [
    {
      sectionId: "pain",
      heading: "Pain",
      required: true,
      allowedCategories: [],
      entries: [
        {
          code: "pain.controlled",
          label: "Pain controlled",
          category: "c",
          bodySystem: null,
          slots: [],
          slotSpecs: {},
          exclusiveGroup: null,
        },
      ],
    },
  ],
};

function mount(
  addenda: readonly AddendumRow[],
  overrides: {
    GET?: ReturnType<typeof vi.fn>;
    PATCH?: ReturnType<typeof vi.fn>;
    POST?: ReturnType<typeof vi.fn>;
  } = {},
  session: { userId: string; organizationId: string } | null = null,
) {
  const onChanged = vi.fn();
  const client = {
    GET:
      overrides.GET ??
      vi.fn(async (path: string) =>
        path === "/api/v1/encounters/{encounterId}/template"
          ? { data: template }
          : {
              data: {
                templateKey: "k",
                vocabVersion: "v",
                sections: [],
                layer1Preview: "",
                version: 3,
              },
            },
      ),
    PATCH:
      overrides.PATCH ??
      vi.fn(async () => ({ data: { version: 4, layer1Preview: "Pain controlled." } })),
    POST: overrides.POST ?? vi.fn(async () => ({ data: { status: "finalized" } })),
  };
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <ApiClientProvider client={client as never}>
            <SessionProvider session={session}>
              <AddendaPanel encounterId="enc-1" addenda={addenda} onChanged={onChanged} />
            </SessionProvider>
          </ApiClientProvider>
        ),
      },
    ],
    { initialEntries: ["/patients/patient-1/encounters/enc-1"] },
  );
  render(<RouterProvider router={router} />);
  return { client, onChanged, router };
}

describe("Addendum panel (GAP-027)", () => {
  it("shows the server status and the author read-only, and offers only the draft actions", () => {
    mount([draft]);
    const row = screen.getByLabelText("Addendum add-1");
    expect(within(row).getByText("mem-author")).toBeTruthy();
    expect(within(row).getByText(draft.reason)).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Edit draft" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Finalize addendum" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Sign addendum" })).toBeNull();
  });

  it("offers no actions on a signed addendum", () => {
    mount([{ ...draft, status: "signed", signedAt: "2026-10-02T10:00:00Z" }]);
    expect(screen.queryByRole("button", { name: /edit draft|finalize|sign addendum/i })).toBeNull();
  });

  it("edits a draft and saves the whole tree with If-Match, sending no identity", async () => {
    const { client } = mount([draft]);
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.click(await screen.findByLabelText("Pain controlled"));
    fireEvent.change(screen.getByLabelText("Pain — additional notes"), {
      target: { value: "Family reports relief." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    const [path, init] = client.PATCH.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(`${BASE}/selections`);
    expect(init).toMatchObject({
      params: {
        path: { encounterId: "enc-1", addendumId: "add-1" },
        header: { "If-Match": "3" },
      },
      body: {
        sections: [
          {
            sectionId: "pain",
            entries: [{ code: "pain.controlled" }],
            freeText: "Family reports relief.",
          },
        ],
      },
    });
    expect(JSON.stringify(init)).not.toMatch(/author|cosign|signer/i);
    expect(await screen.findByText("Addendum changes saved")).toBeTruthy();
  });

  it("keeps one draft editor active at a time", async () => {
    mount([draft, { ...draft, id: "add-2", reason: "Second correction" }]);
    const first = screen.getByLabelText("Addendum add-1");
    const second = screen.getByLabelText("Addendum add-2");

    fireEvent.click(within(first).getByRole("button", { name: "Edit draft" }));
    await screen.findByLabelText("Pain controlled");

    expect(
      (within(second).getByRole("button", { name: "Edit draft" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByLabelText("Pain controlled")).toHaveLength(1);
  });

  it("locks the editor and prevents discarding while a save is in flight", async () => {
    let finishSave: (() => void) | undefined;
    const PATCH = vi.fn(
      () =>
        new Promise<{ data: { version: number; layer1Preview: string } }>((resolve) => {
          finishSave = () => resolve({ data: { version: 4, layer1Preview: "Pain controlled." } });
        }),
    );
    const { router } = mount([draft], { PATCH });
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    const choice = (await screen.findByLabelText("Pain controlled")) as HTMLInputElement;
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(PATCH).toHaveBeenCalledTimes(1));

    expect(choice.disabled).toBe(true);
    expect((screen.getByLabelText("Pain — additional notes") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Close editor" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      await router.navigate("/patients/patient-1/encounters");
    });
    expect(screen.getByText(/addendum is being saved/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard addendum changes" })).toBeNull();

    await act(async () => finishSave?.());
    expect(await screen.findByText("Addendum changes saved")).toBeTruthy();
  });

  it("announces and protects unsaved addendum work until the server saves it", async () => {
    const { client, router } = mount([draft]);
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    expect(
      (screen.getByRole("button", { name: "Finalize addendum" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(await screen.findByLabelText("Pain controlled"));
    expect(screen.getByText("Unsaved addendum changes")).toBeTruthy();

    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    await act(async () => {
      await router.navigate("/patients/patient-1/encounters");
    });
    expect(
      screen.getByRole("alertdialog", { name: "Leave addendum without saving?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing addendum" }));

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(
      screen.getByRole("alertdialog", { name: "Leave addendum without saving?" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing addendum" }));

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Addendum changes saved")).toBeTruthy();
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("shows a 409 STALE_VERSION on save verbatim", async () => {
    mount([draft], {
      PATCH: vi.fn(async () => ({
        error: { error: { code: "STALE_VERSION", message: "version 3 is stale" } },
        response: { status: 409 },
      })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.click(await screen.findByLabelText("Pain controlled"));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    // 77519b66e: the alert is user-facing prose now, not "<status> <CODE>: <message>".
    expect((await screen.findByRole("alert")).textContent).toBe("version 3 is stale");
  });

  it("releases the editor lock when the save transport rejects", async () => {
    mount([draft], {
      PATCH: vi.fn(async () => {
        throw new TypeError("connection dropped");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    const choice = (await screen.findByLabelText("Pain controlled")) as HTMLInputElement;
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/connection was interrupted/i);
    expect(choice.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText("Unsaved addendum changes")).toBeTruthy();
  });

  it("finalizes a draft and reloads from the server", async () => {
    const { client, onChanged } = mount([draft]);
    fireEvent.click(screen.getByRole("button", { name: "Finalize addendum" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(client.POST).toHaveBeenCalledWith(`${BASE}/finalize`, {
      params: { path: { encounterId: "enc-1", addendumId: "add-1" } },
    });
  });

  it.each([
    [403, "FORBIDDEN", "only the addendum's author may do this"],
    [404, "NOT_FOUND", "addendum not found"],
    [409, "ILLEGAL_TRANSITION", "addendum is not a draft"],
    [422, "GATE_FAILED", "required section Pain is empty"],
  ])("shows a %i finalize refusal verbatim", async (status, code, message) => {
    const { onChanged } = mount([draft], {
      POST: vi.fn(async () => ({ error: { error: { code, message } }, response: { status } })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Finalize addendum" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(onChanged).not.toHaveBeenCalled();
  });

  describe("a refused compliance gate speaks of the addendum, in the app's words", () => {
    const GENERIC = "the Layer-3 compliance gate did not pass; the encounter stays in draft";
    const gateRefusal = (details: unknown) =>
      vi.fn(async () => ({
        error: { error: { code: "COMPLIANCE_GATE_FAILED", message: GENERIC, details } },
        response: { status: 422 },
      }));
    const EMPTY = [{ code: "ADDENDUM_EMPTY", message: "an addendum must carry something" }];

    it("finalize: an empty addendum is told what to add, and the sentence about the encounter never shows", async () => {
      const { onChanged } = mount([draft], { POST: gateRefusal(EMPTY) });
      fireEvent.click(screen.getByRole("button", { name: "Finalize addendum" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(
        "This addendum has nothing in it yet. Add a finding or a note, then finalize it.",
      );
      expect(alert.textContent).not.toMatch(/encounter|Layer-3/);
      expect(onChanged).not.toHaveBeenCalled();
    });

    it("finalize: a remediation the app has no words for shows the server's detail, not the top-level sentence", async () => {
      mount([draft], {
        POST: gateRefusal([{ code: "SOMETHING_NEW", message: "the detail the server gave" }]),
      });
      fireEvent.click(screen.getByRole("button", { name: "Finalize addendum" }));
      expect((await screen.findByRole("alert")).textContent).toBe("the detail the server gave");
    });

    it("finalize: an amending addendum is also told it may confirm a redrafted section, if one is offered", async () => {
      mount([{ ...draft, amendsSectionIds: ["pain"] }], { POST: gateRefusal(EMPTY) });
      fireEvent.click(screen.getByRole("button", { name: "Finalize addendum" }));
      expect((await screen.findAllByRole("alert"))[0]?.textContent).toBe(
        "This addendum has nothing in it yet. Add a finding or a note, or confirm a redrafted section if one is offered, then finalize it.",
      );
    });

    it("sign: a free addendum is never told about sections", async () => {
      mount([{ ...draft, status: "finalized" }], { POST: gateRefusal(EMPTY) });
      fireEvent.click(screen.getByRole("button", { name: "Sign addendum" }));
      fireEvent.click(screen.getByLabelText(/I attest this addendum/));
      fireEvent.click(screen.getByRole("button", { name: "Sign & commit" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toMatch(/section|deselect|encounter|Layer-3/i);
    });
  });

  describe("the editor asks for what the addendum's gate needs, not the note's required sections", () => {
    it("says nothing is in it yet, without listing the note's required sections or marking any required", async () => {
      mount([draft]);
      fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
      const editor = await screen.findByLabelText("Addendum editor");
      expect(within(editor).getByText("Pain")).toBeInTheDocument();
      expect(editor.textContent).not.toMatch(/\(required\)|Required before finalizing/);
      expect(
        within(editor).getByText("Nothing here yet. Before finalizing, add a finding or a note."),
      ).toBeInTheDocument();
    });

    it("drops the hint once a finding is picked, and brings it back when it is cleared", async () => {
      mount([draft]);
      fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
      const pick = await screen.findByLabelText("Pain controlled");
      const hint = () => screen.queryByText(/^Nothing here yet\. Before finalizing/);
      expect(hint()).not.toBeNull();
      fireEvent.click(pick);
      expect(hint()).toBeNull();
      fireEvent.click(pick);
      expect(hint()).not.toBeNull();
    });

    it("drops the hint for a note typed in a section too", async () => {
      mount([draft]);
      fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
      fireEvent.change(await screen.findByLabelText("Pain — additional notes"), {
        target: { value: "Family reports relief." },
      });
      expect(screen.queryByText(/^Nothing here yet\. Before finalizing/)).toBeNull();
    });
  });

  it("signs a finalized addendum with the attestation flag only", async () => {
    const POST = vi.fn(async () => ({
      data: { status: "signed", signedAt: "2026-10-05T00:00:00Z" },
    }));
    const { onChanged } = mount([{ ...draft, status: "finalized" }], { POST });
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign addendum" }));
    fireEvent.click(screen.getByLabelText(/I attest this addendum/));
    fireEvent.click(screen.getByRole("button", { name: "Sign & commit" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledWith(`${BASE}/sign`, {
      params: { path: { encounterId: "enc-1", addendumId: "add-1" } },
      body: { attestationConfirmed: true },
    });
  });

  it("surfaces STEP_UP_REQUIRED verbatim with a link to the step-up screen", async () => {
    const POST = vi.fn(async () => ({
      error: { error: { code: "STEP_UP_REQUIRED", message: "re-authenticate to sign" } },
      response: { status: 403 },
    }));
    const { onChanged } = mount([{ ...draft, status: "finalized" }], { POST });
    fireEvent.click(screen.getByRole("button", { name: "Sign addendum" }));
    fireEvent.click(screen.getByLabelText(/I attest this addendum/));
    fireEvent.click(screen.getByRole("button", { name: "Sign & commit" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("re-authenticate to sign");
    expect(
      within(alert).getByRole("link", { name: "Re-authenticate" }).getAttribute("href"),
    ).toMatch(/^\/step-up\?returnTo=/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("Addendum draft survives the step-up round trip (GAP-027)", () => {
  const ME = { userId: "user-1", organizationId: "org-1" };
  const stepUpPatch = () =>
    vi.fn(async () => ({
      error: { error: { code: "STEP_UP_REQUIRED", message: "re-authenticate to save" } },
      response: { status: 403 },
    }));

  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function typeAndSave(PATCH: ReturnType<typeof vi.fn>) {
    mount([draft], { PATCH }, ME);
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.click(await screen.findByLabelText("Pain controlled"));
    fireEvent.change(screen.getByLabelText("Pain — additional notes"), {
      target: { value: "Family reports relief." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByRole("link", { name: "Re-authenticate" }).getAttribute("href"),
    ).toMatch(/^\/step-up\?returnTo=/);
    cleanup();
  }

  const restoredNotes = async () =>
    (await screen.findByLabelText("Pain — additional notes")) as HTMLTextAreaElement;

  it("reopens the editor with the selections and notes that were typed", async () => {
    await typeAndSave(stepUpPatch());
    mount([draft], {}, ME);
    expect((await restoredNotes()).value).toBe("Family reports relief.");
    expect((screen.getByLabelText("Pain controlled") as HTMLInputElement).checked).toBe(true);
  });

  it("clears the draft once it is saved", async () => {
    await typeAndSave(stepUpPatch());
    const { client } = mount([draft], {}, ME);
    await restoredNotes();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    await screen.findByText("Addendum changes saved");
    cleanup();
    mount([draft], {}, ME);
    expect(screen.getByRole("button", { name: "Edit draft" })).toBeTruthy();
    expect(screen.queryByLabelText("Pain — additional notes")).toBeNull();
  });

  it("clears the stashed draft when the clinician discards it", async () => {
    await typeAndSave(stepUpPatch());
    const { router } = mount([draft], {}, ME);
    await restoredNotes();

    await act(async () => {
      await router.navigate("/patients/patient-1/encounters");
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard addendum changes" }));
    cleanup();

    mount([draft], {}, ME);
    expect(screen.getByRole("button", { name: "Edit draft" })).toBeTruthy();
    expect(screen.queryByLabelText("Pain — additional notes")).toBeNull();
  });

  it("does not restore the draft for a different user or org", async () => {
    await typeAndSave(stepUpPatch());
    mount([draft], {}, { ...ME, userId: "user-2" });
    expect(screen.getByRole("button", { name: "Edit draft" })).toBeTruthy();
    expect(screen.queryByLabelText("Pain — additional notes")).toBeNull();
    cleanup();
    mount([draft], {}, { ...ME, organizationId: "org-2" });
    expect(screen.queryByLabelText("Pain — additional notes")).toBeNull();
  });

  it("still shows the re-authenticate link when storage throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await typeAndSave(stepUpPatch());
  });
});

// Until the encounter has been read again the row still reads "draft", so Finalize (and Edit draft) would still be offered after a
// finalize that landed: a second press would be refused by the server. They wait (aria-disabled, never disabled, so the pressed button
// keeps keyboard focus), and when the read lands the buttons that go away must not take focus with them (S1 React review).
describe("the moment between finalizing an addendum and the page showing it finalized", () => {
  it("offers nothing that could finalize again, then puts focus on the addendum", async () => {
    const user = userEvent.setup();
    let land: () => void = () => undefined;
    const read = new Promise<void>((resolve) => {
      land = resolve;
    });
    const POST = vi.fn(async () => ({ data: { status: "finalized" } }));
    const client = {
      GET: vi.fn(async () => ({ data: { sections: [], layer1Preview: "", version: 1 } })),
      PATCH: vi.fn(),
      POST,
    };
    const onChanged = vi.fn(() => read);
    function Host() {
      const [addenda, setAddenda] = useState<readonly AddendumRow[]>([draft]);
      return (
        <AddendaPanel
          encounterId="enc-1"
          addenda={addenda}
          onChanged={() => {
            onChanged();
            return read.then(() => setAddenda([{ ...draft, status: "finalized" }]));
          }}
        />
      );
    }
    const router = createMemoryRouter([{ path: "*", element: <Host /> }], {
      initialEntries: ["/patients/patient-1/encounters/enc-1"],
    });
    render(
      <ApiClientProvider client={client as never}>
        <SessionProvider session={null}>
          <RouterProvider router={router} />
        </SessionProvider>
      </ApiClientProvider>,
    );
    const row = screen.getByLabelText("Addendum add-1");
    const finalize = within(row).getByRole("button", { name: "Finalize addendum" });
    await user.click(finalize);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    // The row still reads draft: the buttons are there, but waiting, and the pressed one kept its focus.
    expect(finalize).toBeInTheDocument();
    expect(finalize).not.toBeDisabled();
    expect(finalize).toHaveAttribute("aria-disabled", "true");
    expect(finalize).toHaveFocus();
    const edit = within(row).getByRole("button", { name: "Edit draft" });
    expect(edit).not.toBeDisabled();
    expect(edit).toHaveAttribute("aria-disabled", "true");
    await user.click(finalize);
    await user.click(edit);
    expect(POST).toHaveBeenCalledTimes(1);
    expect(within(row).queryByLabelText("Pain controlled")).toBeNull();

    land();
    await waitFor(() =>
      expect(within(row).queryByRole("button", { name: "Finalize addendum" })).toBeNull(),
    );
    expect(within(row).getByRole("button", { name: "Sign addendum" })).not.toHaveAttribute(
      "aria-disabled",
    );
    // The Finalize button that held focus is gone: focus is on the addendum itself, not the page.
    await waitFor(() => expect(row).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  });
});
