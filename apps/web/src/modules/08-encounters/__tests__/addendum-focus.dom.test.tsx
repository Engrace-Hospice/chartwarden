// @vitest-environment jsdom
// Where keyboard focus ends once a step on an addendum has landed and the page shows it (S1 fix: in a real browser it ended on the shell's
// "Global search" box). Each case runs the real panel, the real ceremony dialog and the real Modal, with a stand-in for that box ahead of the
// panel and a page that answers the in-place read after a delay, as the screen does. Two ways of opening the dialog: a click that moves focus
// to the button (the usual) and one that leaves focus where it was (the box). Synthetic data only.
// These pin the panel's own behaviour (its focus request after the read lands). They pass against the Modal as it was before the focus-return
// fix too, because that request wins either way: the Modal's cases are in packages/ui modal.dom.test.tsx.
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../../shell/session";
import type { AddendumRow } from "../addenda-api";
import { AddendaPanel } from "../addendum-panel";

const COSIGN = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/cosignature";
const READ_DELAY_MS = 30;

const finalized: AddendumRow = {
  id: "add-1",
  status: "finalized",
  reason: "Pain pattern changed after the family call",
  authoredByUserId: "mem-author",
  createdAt: "2026-10-01T10:00:00Z",
  signedAt: null,
  version: 2,
};
const draft: AddendumRow = { ...finalized, status: "draft" };
const awaitingCosign: AddendumRow = {
  ...finalized,
  status: "signed",
  signedAt: "2026-10-02T10:00:00Z",
  amendsSectionIds: ["pain"],
  cosignStatus: "pending",
};

const author: Session = {
  userId: "user-author",
  organizationId: "org-1",
  membershipId: "mem-author",
  permissions: [],
};
const cosigner: Session = {
  userId: "user-rn",
  organizationId: "org-1",
  membershipId: "mem-rn",
  permissions: ["encounter.cosign"],
};

afterEach(cleanup);

/** The page: the in-place read lands after a delay and replaces the addendum with what the step made of it. */
function mount(start: AddendumRow, after: AddendumRow, session: Session, requestStatus?: string) {
  const POST = vi.fn(async () => ({ data: { status: "ok" } }));
  const GET = vi.fn(async (path: string) =>
    path === COSIGN ? { data: { status: requestStatus ?? null } } : { data: { promotions: [] } },
  );
  function Page() {
    const [addenda, setAddenda] = useState<readonly AddendumRow[]>([start]);
    return (
      <>
        <input type="search" aria-label="Global search" />
        <AddendaPanel
          encounterId="enc-1"
          addenda={addenda}
          noteAuthorId="mem-note"
          onChanged={() =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                setAddenda([after]);
                resolve();
              }, READ_DELAY_MS),
            )
          }
        />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "*", element: <Page /> }], {
    initialEntries: ["/patients/patient-1/encounters/enc-1"],
  });
  render(
    <ApiClientProvider client={{ GET, POST, PUT: vi.fn(), PATCH: vi.fn() } as never}>
      <SessionProvider session={session}>
        <RouterProvider router={router} />
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { user: userEvent.setup(), POST };
}

const row = () => screen.getByLabelText("Addendum add-1");
const search = () => screen.getByLabelText("Global search");

type Opening = "click moves focus to the button" | "click leaves focus on the search box";
const OPENINGS: readonly Opening[] = [
  "click moves focus to the button",
  "click leaves focus on the search box",
];

/** Opens a dialog from its trigger: either as a click does (focus goes to the button), or with focus left on the search box. */
async function press(user: ReturnType<typeof userEvent.setup>, button: HTMLElement, how: Opening) {
  if (how === "click moves focus to the button") return user.click(button);
  search().focus();
  fireEvent.click(button);
}

describe.each(OPENINGS)("focus after a step lands (%s)", (how) => {
  it("the cosigner's Sign cosignature: focus ends on the addendum row, never on the search box", async () => {
    const { user, POST } = mount(
      awaitingCosign,
      { ...awaitingCosign, cosignStatus: "cosigned" },
      cosigner,
      "acknowledged",
    );
    await press(user, await within(row()).findByRole("button", { name: "Sign cosignature" }), how);
    await user.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Sign & commit" }),
    );
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(row()).getByText("Cosigned")).toBeInTheDocument());
    await waitFor(() => expect(row()).toHaveFocus());
    expect(search()).not.toHaveFocus();
  });

  it("the author's Sign addendum: focus ends on the addendum row, never on the search box", async () => {
    const { user, POST } = mount(finalized, { ...finalized, status: "signed" }, author);
    await press(user, within(row()).getByRole("button", { name: "Sign addendum" }), how);
    await user.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Sign & commit" }),
    );
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(row()).queryByRole("button", { name: "Sign addendum" })).toBeNull(),
    );
    await waitFor(() => expect(row()).toHaveFocus());
    expect(search()).not.toHaveFocus();
  });

  it("the author's Finalize addendum: focus ends on the addendum row, never on the search box", async () => {
    const { user, POST } = mount(draft, finalized, author);
    await press(user, within(row()).getByRole("button", { name: "Finalize addendum" }), how);
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(row()).queryByRole("button", { name: "Finalize addendum" })).toBeNull(),
    );
    await waitFor(() => expect(row()).toHaveFocus());
    expect(search()).not.toHaveFocus();
  });
});
