// What the composer's Finalize does to the screen around a refusal or an interrupted connection: the draft (text, hash, state) is
// re-read after the save that came first, and the typed late-entry reason goes once the server confirms the note is finalized.
// No React: createComposeWrites is plain closures over a context, so the context is stubbed. Synthetic ids only.
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { type ComposeWritesContext, createComposeWrites } from "../compose/compose-writes";
import type { EncounterView } from "../encounters-api";
import type { LateEntryReasonState } from "../use-late-entry-reason";

const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const lateEntryRefusal = {
  error: { code: "LATE_ENTRY_REASON_REQUIRED", message: "a reason is required" },
};

function stubClient(finalize: () => Promise<unknown>): ApiClient {
  return {
    PATCH: vi.fn(async () => ({
      data: { version: 4, layer1Preview: "preview" },
      response: { status: 200 },
    })),
    POST: vi.fn(finalize),
  } as unknown as ApiClient;
}

function stubLateEntry(absorbs: boolean): LateEntryReasonState {
  return {
    reason: "",
    setReason: vi.fn(),
    estimate: null,
    visible: true,
    pending: false,
    refusedAndShort: false,
    unsent: false,
    focusRequests: 0,
    reasonForFinalize: undefined,
    absorbRefusal: vi.fn(() => absorbs),
    clear: vi.fn(),
  };
}

function stubContext(client: ApiClient, lateEntry: LateEntryReasonState) {
  const reloadDraft = vi.fn(async () => undefined);
  const setFeedback = vi.fn();
  const load = vi.fn(
    async (): Promise<EncounterView | null> => ({ status: "draft" }) as EncounterView,
  );
  const context: ComposeWritesContext = {
    client,
    encounterId: ENCOUNTER,
    version: 3,
    draft: {},
    effectiveFallId: null,
    currentDraft: "{}",
    editedNarrative: null,
    selectionsDirty: false,
    dirtyPanels: [],
    panelTitle: (key) => key,
    showPanel: vi.fn(),
    headingOfSection: (id) => id,
    lateEntry,
    previewRead: { current: 0 },
    readStored: vi.fn(async () => null),
    applyStored: vi.fn(),
    refreshPreview: vi.fn(async () => undefined),
    reloadDraft,
    refuse: vi.fn(),
    load,
    setFeedback,
    setOperation: vi.fn(),
    setError: vi.fn(),
    setVersion: vi.fn(),
    setPreview: vi.fn(),
    setPreviewStale: vi.fn(),
    setLastSavedDraft: vi.fn(),
    setEditing: vi.fn(),
    setEditText: vi.fn(),
  };
  return { context, reloadDraft, setFeedback, load };
}

describe("finalize", () => {
  it("re-reads the draft after the save even when the server's late-entry refusal is absorbed by the reason box", async () => {
    const client = stubClient(async () => ({
      error: lateEntryRefusal,
      response: { status: 422 },
    }));
    const lateEntry = stubLateEntry(true);
    const { context, reloadDraft, setFeedback } = stubContext(client, lateEntry);

    await createComposeWrites(context).finalize();

    expect(lateEntry.absorbRefusal).toHaveBeenCalledTimes(1);
    expect(reloadDraft).toHaveBeenCalledTimes(1);
    // The reason box answers the refusal: no other notice is raised.
    expect(setFeedback).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("clears the typed reason when the note is confirmed finalized after the connection was interrupted", async () => {
    const client = stubClient(async () => {
      throw new Error("network down");
    });
    const lateEntry = stubLateEntry(false);
    const { context, load, setFeedback } = stubContext(client, lateEntry);
    load.mockResolvedValue({ status: "finalized" } as EncounterView);

    await createComposeWrites(context).finalize();

    expect(lateEntry.clear).toHaveBeenCalledTimes(1);
    expect(setFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Note finalized", tone: "success" }),
    );
  });

  it("keeps the typed reason when the note is still a draft after the connection was interrupted", async () => {
    const client = stubClient(async () => {
      throw new Error("network down");
    });
    const lateEntry = stubLateEntry(false);
    const { context, load } = stubContext(client, lateEntry);
    load.mockResolvedValue({ status: "draft" } as EncounterView);

    await createComposeWrites(context).finalize();

    expect(lateEntry.clear).not.toHaveBeenCalled();
  });
});
