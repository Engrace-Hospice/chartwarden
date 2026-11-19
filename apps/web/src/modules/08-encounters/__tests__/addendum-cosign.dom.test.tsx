// @vitest-environment jsdom
// Working the cosignature of an AMENDMENT on the addendum panel (ADR-0114 VN-D30, S1 PR E4): a signed amending addendum whose cosignature is
// pending shows the cosigner's ceremony (acknowledge, sign with attestation, supervisor release) to a viewer who may act, and says in words
// why it is not offered to one who may not. After a sign the amendment reads "Cosigned". Synthetic data only.
import { ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../../shell/session";
import type { AddendumRow } from "../addenda-api";
import { AddendaPanel } from "../addendum-panel";

const BASE = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/cosignature";
const LONG_REASON =
  "The cosigner was on leave past the cap, so I am releasing this for the cover RN.";

const pending: AddendumRow = {
  id: "add-1",
  status: "signed",
  reason: "Pain pattern changed after the family call",
  authoredByUserId: "mem-author",
  createdAt: "2026-10-01T10:00:00Z",
  signedAt: "2026-10-02T10:00:00Z",
  version: 2,
  amendsSectionIds: ["pain", "plan"],
  cosignStatus: "pending",
};

const rn: Session = {
  userId: "user-rn",
  organizationId: "org-1",
  membershipId: "mem-rn",
  permissions: ["encounter.cosign"],
};

let requestStatus: string | null;
let requestRead: "ok" | "refused";

beforeEach(() => {
  requestStatus = "routed";
  requestRead = "ok";
});
afterEach(cleanup);

type Post = ReturnType<typeof vi.fn>;
function mount(
  addenda: readonly AddendumRow[],
  {
    session = rn,
    post = vi.fn(async () => ({ data: { status: "acknowledged" } })),
    noteAuthorId = "mem-note",
    at = "/patients/patient-1/encounters/enc-1",
  }: { session?: Session | null; post?: Post; noteAuthorId?: string | null; at?: string } = {},
) {
  const onChanged = vi.fn();
  const GET = vi.fn(async (path: string) => {
    if (path !== BASE) return { data: { promotions: [] } };
    return requestRead === "ok"
      ? { data: { status: requestStatus } }
      : { error: { error: { code: "NOT_FOUND", message: "no" } }, response: { status: 404 } };
  });
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <ApiClientProvider client={{ GET, POST: post, PUT: vi.fn(), PATCH: vi.fn() } as never}>
            <SessionProvider session={session}>
              <AddendaPanel
                encounterId="enc-1"
                addenda={addenda}
                noteAuthorId={noteAuthorId}
                onChanged={onChanged}
              />
            </SessionProvider>
          </ApiClientProvider>
        ),
      },
    ],
    { initialEntries: [at] },
  );
  render(<RouterProvider router={router} />);
  return { GET, post, onChanged, user: userEvent.setup() };
}

const row = (id = "add-1") => screen.getByLabelText(`Addendum ${id}`);
const panel = (id = "add-1") =>
  within(row(id)).queryByRole("region", { name: /^Cosign this amendment/ });
const reads = (GET: ReturnType<typeof mount>["GET"]) =>
  GET.mock.calls.filter(([path]) => path === BASE).length;

describe("the cosigner's panel on a pending amendment", () => {
  it("shows the pending cosignature in words and reads the amendment's own request", async () => {
    const { GET } = mount([pending]);
    expect(within(row()).getByText("Cosignature of this amendment")).toBeInTheDocument();
    expect(within(row()).getByText("Pending cosignature")).toBeInTheDocument();
    expect(
      await within(row()).findByText("Waiting for the cosigner to acknowledge it."),
    ).toBeInTheDocument();
    expect(GET).toHaveBeenCalledWith(BASE, {
      params: { path: { encounterId: "enc-1", addendumId: "add-1" } },
    });
    expect(
      within(row()).getByRole("button", { name: "Acknowledge cosignature" }),
    ).toBeInTheDocument();
    expect(within(row()).queryByRole("button", { name: "Sign cosignature" })).toBeNull();
    expect(within(row()).queryByRole("button", { name: "Supervisor release" })).toBeNull();
  });

  it("acknowledges through the amendment's route, then reads the request and the page again", async () => {
    const { GET, post, onChanged, user } = mount([pending]);
    await user.click(await within(row()).findByRole("button", { name: "Acknowledge cosignature" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Acknowledge" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(`${BASE}/acknowledge`, {
      params: { path: { encounterId: "enc-1", addendumId: "add-1" } },
    });
    await waitFor(() => expect(reads(GET)).toBe(2));
  });

  it("offers the signature once the request is acknowledged, and sends the attestation", async () => {
    requestStatus = "acknowledged";
    const { post, user } = mount([pending]);
    await user.click(await within(row()).findByRole("button", { name: "Sign cosignature" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Cosign amendment")).toBeInTheDocument();
    expect(within(dialog).getByText(pending.reason)).toBeInTheDocument();
    expect(within(dialog).getByText("Pain, Plan")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Sign & commit" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`${BASE}/sign`, {
        params: { path: { encounterId: "enc-1", addendumId: "add-1" } },
        body: { attestationConfirmed: true },
      }),
    );
  });

  it("reads Cosigned after the sign, and the panel steps aside", async () => {
    requestStatus = "acknowledged";
    function Page() {
      const [addenda, setAddenda] = useState<readonly AddendumRow[]>([pending]);
      return (
        <AddendaPanel
          encounterId="enc-1"
          addenda={addenda}
          noteAuthorId="mem-note"
          onChanged={() => setAddenda([{ ...pending, cosignStatus: "cosigned" }])}
        />
      );
    }
    const post = vi.fn(async () => ({
      data: { status: "signed", cosignedAt: "2026-11-02T10:00:00Z" },
    }));
    const GET = vi.fn(async (path: string) =>
      path === BASE ? { data: { status: requestStatus } } : { data: { promotions: [] } },
    );
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <ApiClientProvider client={{ GET, POST: post } as never}>
              <SessionProvider session={rn}>
                <Page />
              </SessionProvider>
            </ApiClientProvider>
          ),
        },
      ],
      { initialEntries: ["/patients/patient-1/encounters/enc-1"] },
    );
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(await within(row()).findByRole("button", { name: "Sign cosignature" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Sign & commit" }),
    );
    await waitFor(() => expect(within(row()).getByText("Cosigned")).toBeInTheDocument());
    expect(within(row()).queryByText("Pending cosignature")).toBeNull();
    expect(panel()).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign cosignature" })).toBeNull();
  });

  it("offers a supervisor the release once the request is locked at the cap, with the reason it needs", async () => {
    requestStatus = "hard_cap_reached";
    const { post, user } = mount([pending], {
      session: { ...rn, permissions: ["encounter.cosign_supervisor_release"] },
      post: vi.fn(async () => ({ data: { status: "supervisor_released" } })),
    });
    expect(await within(row()).findByText(/Locked at the 48-hour cap/)).toBeInTheDocument();
    await user.click(within(row()).getByRole("button", { name: "Supervisor release" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/An RN still has to sign it/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: /reason/i }), LONG_REASON);
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0] as unknown as [string, { body: { reason: string } }];
    expect(path).toBe(`${BASE}/supervisor-release`);
    expect(init.body.reason).toBe(LONG_REASON);
  });

  it("says a released amendment is released, and still offers the RN the signature", async () => {
    requestStatus = "supervisor_released";
    mount([{ ...pending, cosignStatus: "released" }]);
    expect(within(row()).getByText("Released by a supervisor")).toBeInTheDocument();
    expect(
      await within(row()).findByText("Released by a supervisor. An RN still has to sign."),
    ).toBeInTheDocument();
    expect(within(row()).getByRole("button", { name: "Sign cosignature" })).toBeInTheDocument();
  });

  it("says what a 403 means in the dialog, in words, with no link to re-authenticate", async () => {
    const { user } = mount([pending], {
      post: vi.fn(async () => ({
        error: { error: { code: "FORBIDDEN", message: "no self-cosign" } },
        response: { status: 403 },
      })),
    });
    await user.click(await within(row()).findByRole("button", { name: "Acknowledge cosignature" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Acknowledge" }),
    );
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      /RN with cosign access who wrote neither the note nor this amendment/,
    );
  });
});

describe("who the cosigner's panel is offered to", () => {
  it("tells the amendment's own author they cannot cosign it, and reads nothing", () => {
    const { GET } = mount([pending], { session: { ...rn, membershipId: "mem-author" } });
    expect(
      within(row()).getByText(/You wrote this amendment, so you cannot cosign it/),
    ).toBeInTheDocument();
    expect(within(row()).queryByRole("button", { name: /cosignature|release/i })).toBeNull();
    expect(reads(GET)).toBe(0);
  });

  it("tells the note's author the same, naming the note", () => {
    mount([pending], { session: { ...rn, membershipId: "mem-note" } });
    expect(
      within(row()).getByText(/You wrote the note this amendment belongs to/),
    ).toBeInTheDocument();
    expect(within(row()).queryByRole("button", { name: /cosignature/i })).toBeNull();
  });

  it("tells a viewer without cosign access that their role cannot cosign", () => {
    const { GET } = mount([pending], { session: { ...rn, permissions: ["encounter.read"] } });
    expect(within(row()).getByText(/Your role cannot cosign/)).toBeInTheDocument();
    expect(within(row()).queryByRole("button", { name: /cosignature|release/i })).toBeNull();
    expect(reads(GET)).toBe(0);
  });

  it("offers nothing, and says nothing it cannot back, when the permissions are unknown", () => {
    const { GET } = mount([pending], { session: { ...rn, permissions: undefined } });
    expect(within(row()).queryByRole("button", { name: /cosignature|release/i })).toBeNull();
    expect(within(row()).queryByText(/cannot cosign/)).toBeNull();
    expect(reads(GET)).toBe(0);
  });

  it("is not shown for an amendment that is not signed, a free addendum, or one with no pending cosignature", () => {
    const { GET } = mount([
      { ...pending, id: "a-draft", status: "draft", signedAt: null },
      { ...pending, id: "a-free", amendsSectionIds: [] },
      { ...pending, id: "a-none", cosignStatus: "not_required" },
      { ...pending, id: "a-null", cosignStatus: null },
      { ...pending, id: "a-done", cosignStatus: "cosigned" },
    ]);
    expect(screen.queryByRole("region", { name: /^Cosign this amendment/ })).toBeNull();
    expect(reads(GET)).toBe(0);
  });

  it("shows nothing about a cosignature that was not needed, and Cosigned for one that is done", () => {
    mount([
      { ...pending, id: "a-none", cosignStatus: "not_required" },
      { ...pending, id: "a-done", cosignStatus: "cosigned" },
    ]);
    expect(within(row("a-none")).queryByText("Cosignature of this amendment")).toBeNull();
    expect(within(row("a-done")).getByText("Cosigned")).toBeInTheDocument();
  });
});

describe("when the request cannot be read", () => {
  it("says so and offers no step, rather than guess", async () => {
    requestRead = "refused";
    mount([pending]);
    expect(await within(row()).findByRole("alert")).toHaveTextContent(
      /The cosignature request could not be read/,
    );
    expect(within(row()).queryByRole("button", { name: /cosignature|release/i })).toBeNull();
  });
});

describe("two amendments pending on one note", () => {
  it("name their panels apart, by when each was opened", async () => {
    mount([pending, { ...pending, id: "add-2", createdAt: "2026-10-03T09:30:00Z" }]);
    const first = await within(row("add-1")).findByRole("region", {
      name: /^Cosign this amendment/,
    });
    const second = await within(row("add-2")).findByRole("region", {
      name: /^Cosign this amendment/,
    });
    const names = [first, second].map((region) => region.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain("2026-10-01 10:00");
    expect(names[1]).toContain("2026-10-03 09:30");
  });
});

describe("reaching an amendment's panel from the cosignature queue", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as never;
  });
  // jsdom has no scrollIntoView: leave it as it was found.
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("scrolls to and focuses the panel the link's anchor names", async () => {
    mount([pending, { ...pending, id: "add-2" }], {
      at: "/patients/patient-1/encounters/enc-1#addendum-cosign-add-2",
    });
    const target = await within(row("add-2")).findByRole("region", {
      name: /^Cosign this amendment/,
    });
    expect(target.id).toBe("addendum-cosign-add-2");
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(scrollIntoView).toHaveBeenCalled();
    expect(panel("add-1")?.id).toBe("addendum-cosign-add-1");
    expect(document.activeElement).not.toBe(panel("add-1"));
  });

  it("moves nothing when the page is opened without an anchor", async () => {
    mount([pending]);
    await within(row()).findByRole("region", { name: /^Cosign this amendment/ });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("has no axe violations with the panel and its action showing", async () => {
    const { GET } = mount([pending]);
    await within(row()).findByRole("button", { name: "Acknowledge cosignature" });
    await act(async () => {});
    expect(reads(GET)).toBeGreaterThan(0);
    expect((await axe.run(row())).violations).toEqual([]);
  });
});
