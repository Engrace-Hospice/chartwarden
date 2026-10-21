import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
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
  render(
    <MemoryRouter>
      <ApiClientProvider client={client as never}>
        <SessionProvider session={session}>
          <AddendaPanel encounterId="enc-1" addenda={addenda} onChanged={onChanged} />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { client, onChanged };
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
    expect(await screen.findByText("Draft saved.")).toBeTruthy();
  });

  it("shows a 412 on save verbatim", async () => {
    mount([draft], {
      PATCH: vi.fn(async () => ({
        error: { error: { code: "STALE_VERSION", message: "version 3 is stale" } },
        response: { status: 412 },
      })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    fireEvent.click(await screen.findByLabelText("Pain controlled"));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    // 77519b66e: the alert is user-facing prose now, not "<status> <CODE>: <message>".
    expect((await screen.findByRole("alert")).textContent).toBe("version 3 is stale");
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
    await screen.findByText("Draft saved.");
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
