// The autosave status line must not claim the text is kept "on this device": it lives in this tab's memory only
// (nothing is written to browser storage), so closing the tab loses it.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DraftSyncNotice } from "./draft-conflict-prompt";
import type { ServerDraftSync } from "./use-server-draft";

const sync = (over: Partial<ServerDraftSync>): ServerDraftSync => ({
  conflict: null,
  saveFailed: true,
  saveGaveUp: false,
  sbarSaved: false,
  resolve: () => {},
  ...over,
});

afterEach(cleanup);

describe("DraftSyncNotice wording", () => {
  it("says the draft is kept in this tab only when autosave gave up", () => {
    render(<DraftSyncNotice sync={sync({ saveGaveUp: true })} />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("kept in this tab only");
    expect(text).toContain("closing the tab loses it");
    expect(text).not.toMatch(/on this device/i);
  });

  it("keeps the retrying line free of any persistence claim", () => {
    render(<DraftSyncNotice sync={sync({})} />);
    expect(screen.getByRole("status").textContent).not.toMatch(/on this device/i);
  });

  it("renders nothing while saves succeed", () => {
    const { container } = render(<DraftSyncNotice sync={sync({ saveFailed: false })} />);
    expect(container.textContent).toBe("");
  });
});
