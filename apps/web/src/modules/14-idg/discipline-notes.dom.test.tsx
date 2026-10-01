// Live meeting — per-discipline notes: render per discipline, create, edit (If-Match), 412, Part 2, not-live, poll safety.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { LiveMeeting } from "./live-meeting";

const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const P1 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ME = "me-membership";
const OTHER = "other-membership";
const ref = { displayName: "Henry N.", mrnSuffix: "A7AC" };
const at = "2026-08-27T09:05:00.000Z";

const note = (over: Record<string, unknown>) => ({
  id: "n-1",
  meetingId: MEETING,
  patientId: P1,
  discipline: "rn_case_manager",
  bodyText: "Pain controlled.",
  bodyWithheld: false,
  authorMembershipId: ME,
  authorName: "Sam Nurse",
  isAddendum: false,
  addendumRecordedAt: null,
  reason: null,
  version: 1,
  createdAt: at,
  updatedAt: at,
  patient: ref,
  ...over,
});

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}
let notes: Record<string, unknown>[] = [];
let calls: Call[] = [];
let status = "live";
let adjournedAt: string | null = null;
let patchStatus = 200;
let postResponse: (() => Response) | null = null;
let noteGets = 0;
let addendumState: Record<string, unknown> | null = null;

const json = (v: unknown, code = 200) =>
  new Response(JSON.stringify(v), {
    status: code,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const req = input as Request;
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const method = req.method;
  if (path.includes("/discipline-notes")) {
    if (method === "GET") {
      noteGets += 1;
      return json(notes);
    }
    const body = (await req.json()) as Record<string, unknown>;
    calls.push({ method, path, headers: req.headers, body });
    if (method === "POST") {
      if (postResponse) return postResponse();
      const row = note({
        id: `n-new-${notes.length}`,
        patientId: body.patientId ?? null,
        discipline: body.discipline,
        bodyText: body.bodyText,
        reason: body.reason ?? null,
        ...(status === "adjourned" ? { isAddendum: true, addendumRecordedAt: at } : {}),
      });
      notes = [...notes, row];
      return json(row, 201);
    }
    if (patchStatus !== 200) {
      return json({ error: { code: "STALE_VERSION", message: "stale write" } }, patchStatus);
    }
    const id = path.split("/").pop();
    const row = notes.find((n) => n.id === id) as Record<string, unknown>;
    const next = {
      ...row,
      ...("bodyText" in body ? { bodyText: body.bodyText } : {}),
      ...("reason" in body ? { reason: body.reason } : {}),
      version: (row.version as number) + 1,
    };
    notes = notes.map((n) => (n.id === id ? next : n));
    return json(next);
  }
  if (path.endsWith("/minutes"))
    return addendumState ? json({ id: "min-1", meetingId: MEETING, addendumState }) : json({}, 404);
  if (path.endsWith("/recert-windows")) return json({ items: [] });
  if (path.endsWith("/attendance"))
    return json([
      {
        id: "att-1",
        meetingId: MEETING,
        membershipId: ME,
        discipline: "msw",
        status: "present",
        checkedInAt: at,
      },
      {
        id: "att-2",
        meetingId: MEETING,
        membershipId: OTHER,
        discipline: "rn_case_manager",
        status: "present",
        checkedInAt: at,
      },
    ]);
  if (path.endsWith("/agenda"))
    return json([
      { id: "ag-1", meetingId: MEETING, kind: "patient_review", patientId: P1, patient: ref },
    ]);
  if (path.endsWith("/decisions")) return json([]);
  if (path.endsWith("/packets"))
    return json([
      { packetId: "p-1", meetingId: MEETING, patientId: P1, patient: ref, frozenAt: null },
    ]);
  if (path.endsWith("/idg/action-items")) return json([]);
  if (path.includes("/members")) return json({ members: [] });
  return json({
    id: MEETING,
    organizationId: "org-1",
    locationId: "loc-1",
    status,
    scheduledStart: "2026-08-27T09:00:00.000Z",
    scheduledEnd: "2026-08-27T10:00:00.000Z",
    adjournedAt,
    coordinatorMembershipId: "coord-1",
  });
}

const mount = () =>
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "org-1",
          membershipId: ME,
          roles: [],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[`/idg/meetings/${MEETING}/live`]}>
            <Routes>
              <Route path="/idg/meetings/:id/live" element={<LiveMeeting />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );

beforeEach(() => {
  notes = [];
  calls = [];
  status = "live";
  adjournedAt = null;
  patchStatus = 200;
  postResponse = null;
  noteGets = 0;
  addendumState = null;
});
afterEach(cleanup);

const panel = async () => screen.findByRole("region", { name: "Discipline notes" });
const tab = (p: HTMLElement, name: RegExp) => within(p).getByRole("tab", { name });
const composer = (p: HTMLElement) =>
  within(p).getByLabelText(/^Add a note for/) as HTMLTextAreaElement;

describe("Discipline notes", () => {
  it("renders notes per discipline with counts, defaulting to the caller's own discipline", async () => {
    notes = [
      note({
        id: "n-1",
        discipline: "rn_case_manager",
        bodyText: "RN text one",
        authorMembershipId: OTHER,
        authorName: "Olive Other",
      }),
      note({ id: "n-2", discipline: "msw", bodyText: "MSW text one" }),
      note({ id: "n-3", discipline: "msw", bodyText: "MSW text two", version: 2 }),
      note({
        id: "n-4",
        patientId: null,
        discipline: "chaplain",
        bodyText: "Team-level chaplain text",
      }),
    ];
    mount();
    const p = await panel();
    // Caller is present as MSW -> that tab is selected by default.
    await waitFor(() => expect(tab(p, /MSW/).getAttribute("aria-selected")).toBe("true"));
    expect(within(p).getByText("MSW text one")).toBeTruthy();
    expect(within(p).getByText("MSW text two")).toBeTruthy();
    expect(within(p).getByText("Edited")).toBeTruthy();
    expect(tab(p, /MSW/).textContent).toContain("2");
    expect(tab(p, /^RN/).textContent).toContain("1");
    // Other discipline, then the meeting-level scope.
    fireEvent.click(tab(p, /^RN/));
    expect(within(p).getByText("RN text one")).toBeTruthy();
    expect(within(p).getByText("Olive Other")).toBeTruthy();
    expect(within(p).queryByText("MSW text one")).toBeNull();
    fireEvent.click(within(p).getByRole("button", { name: /Meeting-level/ }));
    fireEvent.click(tab(p, /Chaplain/));
    expect(within(p).getByText("Team-level chaplain text")).toBeTruthy();
  });

  it("shows an empty state for a discipline with no notes", async () => {
    mount();
    const p = await panel();
    expect(await within(p).findByText(/No MSW notes yet/)).toBeTruthy();
  });

  it("disables Save for whitespace-only text, counts characters, and creates a note", async () => {
    mount();
    const p = await panel();
    await waitFor(() => expect(tab(p, /MSW/).getAttribute("aria-selected")).toBe("true"));
    const save = within(p).getByRole("button", { name: "Save note" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(composer(p), { target: { value: "   \n " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(composer(p), { target: { value: "Family meeting held" } });
    expect(within(p).getByText("19 / 4000")).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await within(p).findByText("Family meeting held")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      patientId: P1,
      discipline: "msw",
      bodyText: "Family meeting held",
    });
    expect(post?.body).not.toHaveProperty("reason"); // blank reason is omitted
    expect(post?.headers.get("Idempotency-Key")).toBeTruthy();
    expect(composer(p).value).toBe("");
  });

  it("live note with a reason: optional field, counter, sends the trimmed reason, renders it", async () => {
    mount();
    const p = await panel();
    await waitFor(() => expect(tab(p, /MSW/).getAttribute("aria-selected")).toBe("true"));
    const reasonInput = within(p).getByLabelText("Context / reason (optional)") as HTMLInputElement;
    expect(within(p).getByText("0 / 500")).toBeTruthy();
    fireEvent.change(composer(p), { target: { value: "Caregiver strain noted" } });
    expect(
      (within(p).getByRole("button", { name: "Save note" }) as HTMLButtonElement).disabled,
    ).toBe(false); // text alone is enough
    fireEvent.change(reasonInput, { target: { value: "  Follow-up to Tuesday  " } });
    expect(within(p).getByText("24 / 500")).toBeTruthy();
    fireEvent.click(within(p).getByRole("button", { name: "Save note" }));
    expect(await within(p).findByText("Reason: Follow-up to Tuesday")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      patientId: P1,
      discipline: "msw",
      bodyText: "Caregiver strain noted",
      reason: "Follow-up to Tuesday",
    });
    expect(reasonInput.value).toBe("");
  });

  it("whitespace-only live reason is omitted", async () => {
    mount();
    const p = await panel();
    fireEvent.change(within(p).getByLabelText("Context / reason (optional)"), {
      target: { value: "   " },
    });
    fireEvent.change(composer(p), { target: { value: "Only text" } });
    fireEvent.click(within(p).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls[0]?.body).not.toHaveProperty("reason");
  });

  it("renders the reason on an original note, and edit sends only what changed (text, reason, clear)", async () => {
    notes = [
      note({
        id: "n-2",
        discipline: "msw",
        bodyText: "Old text",
        reason: "Old reason",
        version: 1,
      }),
    ];
    mount();
    const p = await panel();
    expect(await within(p).findByText("Reason: Old reason")).toBeTruthy();
    // Reason only.
    fireEvent.click(within(p).getByRole("button", { name: "Edit" }));
    const save = () => within(p).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true); // nothing changed
    fireEvent.change(within(p).getByLabelText("Edit note reason"), {
      target: { value: "New reason" },
    });
    fireEvent.click(save());
    expect(await within(p).findByText("Reason: New reason")).toBeTruthy();
    expect(calls.filter((c) => c.method === "PATCH")[0]?.body).toEqual({ reason: "New reason" });
    // Text only.
    fireEvent.click(within(p).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(p).getByLabelText("Edit note text"), { target: { value: "New text" } });
    fireEvent.click(save());
    await within(p).findByText("New text");
    expect(calls.filter((c) => c.method === "PATCH")[1]?.body).toEqual({ bodyText: "New text" });
    // Clear the reason.
    fireEvent.click(within(p).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(p).getByLabelText("Edit note reason"), { target: { value: "  " } });
    fireEvent.click(save());
    await waitFor(() => expect(within(p).queryByText(/^Reason:/)).toBeNull());
    expect(calls.filter((c) => c.method === "PATCH")[2]?.body).toEqual({ reason: null });
  });

  it("writes a meeting-level note with patientId null", async () => {
    mount();
    const p = await panel();
    fireEvent.click(within(p).getByRole("button", { name: /Meeting-level/ }));
    fireEvent.change(composer(p), { target: { value: "Team item" } });
    fireEvent.click(within(p).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls[0]?.body?.patientId).toBeNull();
  });

  it("shows the server's 403 inline and keeps the draft", async () => {
    postResponse = () =>
      json({ error: { code: "FORBIDDEN", message: "not present for that discipline" } }, 403);
    mount();
    const p = await panel();
    fireEvent.change(composer(p), { target: { value: "Attempt" } });
    fireEvent.click(within(p).getByRole("button", { name: "Save note" }));
    expect((await within(p).findByRole("alert")).textContent).toContain("not present");
    expect(composer(p).value).toBe("Attempt");
  });

  it("maps 422 MEETING_NOT_LIVE and INCLUSION_CRITERIA_FAILED to clear copy", async () => {
    postResponse = () => json({ error: { code: "MEETING_NOT_LIVE", message: "x" } }, 422);
    mount();
    const p = await panel();
    fireEvent.change(composer(p), { target: { value: "Late" } });
    fireEvent.click(within(p).getByRole("button", { name: "Save note" }));
    expect((await within(p).findByRole("alert")).textContent).toContain("no longer live");
    postResponse = () => json({ error: { code: "INCLUSION_CRITERIA_FAILED", message: "x" } }, 422);
    fireEvent.click(within(p).getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(within(p).getByRole("alert").textContent).toContain("not on this meeting's agenda"),
    );
  });

  it("edits an own note with If-Match = the note version", async () => {
    notes = [note({ id: "n-2", discipline: "msw", bodyText: "Old text", version: 3 })];
    mount();
    const p = await panel();
    fireEvent.click(await within(p).findByRole("button", { name: "Edit" }));
    fireEvent.change(within(p).getByLabelText("Edit note text"), { target: { value: "New text" } });
    fireEvent.click(within(p).getByRole("button", { name: "Save changes" }));
    expect(await within(p).findByText("New text")).toBeTruthy();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.headers.get("If-Match")).toBe("3");
    expect(patch?.headers.get("Idempotency-Key")).toBeTruthy();
    expect(patch?.body).toEqual({ bodyText: "New text" });
  });

  it("does not offer Edit on someone else's note (non-coordinator)", async () => {
    notes = [note({ id: "n-9", discipline: "msw", authorMembershipId: OTHER })];
    mount();
    const p = await panel();
    await within(p).findByText("Pain controlled.");
    expect(within(p).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("on 412 keeps the draft, reloads, and explains", async () => {
    notes = [note({ id: "n-2", discipline: "msw", bodyText: "Old text", version: 1 })];
    patchStatus = 412;
    mount();
    const p = await panel();
    fireEvent.click(await within(p).findByRole("button", { name: "Edit" }));
    fireEvent.change(within(p).getByLabelText("Edit note text"), { target: { value: "Mine" } });
    const before = noteGets;
    // The other writer saved first.
    notes = [note({ id: "n-2", discipline: "msw", bodyText: "Theirs", version: 2 })];
    fireEvent.click(within(p).getByRole("button", { name: "Save changes" }));
    const alert = await within(p).findByRole("alert");
    expect(alert.textContent).toContain("changed by someone else");
    expect(noteGets).toBeGreaterThan(before);
    expect((within(p).getByLabelText("Edit note text") as HTMLTextAreaElement).value).toBe("Mine");
    expect(within(p).getByText("Theirs")).toBeTruthy();
    // The next save carries the reloaded version.
    patchStatus = 200;
    fireEvent.click(within(p).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]?.headers.get("If-Match")).toBe("2");
  });

  it("renders a Part 2 pill and never the text of a withheld note", async () => {
    notes = [
      note({ id: "n-w", discipline: "msw", bodyText: "SECRET-SUD-TEXT", bodyWithheld: true }),
    ];
    mount();
    const p = await panel();
    expect(await within(p).findByText("Withheld — Part 2")).toBeTruthy();
    expect(p.textContent).not.toContain("SECRET-SUD-TEXT");
    expect(p.textContent).not.toContain("Reason:");
    expect(within(p).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("disables the composer with an explanation when the meeting is neither live nor adjourned", async () => {
    status = "cancelled";
    notes = [note({ id: "n-2", discipline: "msw", bodyText: "Kept readable" })];
    mount();
    const p = await panel();
    expect(await within(p).findByText("Kept readable")).toBeTruthy();
    expect(
      within(p).getByText(/not live — notes can be added or edited only while it is live/),
    ).toBeTruthy();
    expect(composer(p).disabled).toBe(true);
    expect(
      (within(p).getByRole("button", { name: "Save note" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(p).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("a live poll refreshes the list but never clobbers an in-progress draft or open edit", async () => {
    notes = [note({ id: "n-2", discipline: "msw", bodyText: "First" })];
    mount();
    const p = await panel();
    fireEvent.change(composer(p), { target: { value: "half-typed draft" } });
    fireEvent.click(await within(p).findByRole("button", { name: "Edit" }));
    fireEvent.change(within(p).getByLabelText("Edit note text"), { target: { value: "editing…" } });
    const before = noteGets;
    notes = [
      ...notes,
      note({
        id: "n-3",
        discipline: "msw",
        bodyText: "Arrived by poll",
        authorMembershipId: OTHER,
      }),
    ];
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(noteGets).toBeGreaterThan(before));
    expect(await within(p).findByText("Arrived by poll")).toBeTruthy();
    expect(composer(p).value).toBe("half-typed draft");
    expect((within(p).getByLabelText("Edit note text") as HTMLTextAreaElement).value).toBe(
      "editing…",
    );
  });

  describe("late addenda (adjourned meeting)", () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const addComposer = (p: HTMLElement) =>
      within(p).getByLabelText(/^Add late addendum for/) as HTMLTextAreaElement;
    const reasonBox = (p: HTMLElement) =>
      within(p).getByLabelText("Reason for the late addendum") as HTMLTextAreaElement;

    it("in the window: reason + text required, sends reason, no Edit controls, addendum renders", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(2);
      notes = [note({ id: "n-2", discipline: "msw", bodyText: "Frozen original" })];
      mount();
      const p = await panel();
      expect(await within(p).findByText("Frozen original")).toBeTruthy();
      expect(within(p).queryByRole("button", { name: "Edit" })).toBeNull();
      expect(
        within(p).getByText(/Recorded after adjournment\. The frozen minutes are not changed/),
      ).toBeTruthy();
      expect(within(p).getByText(/Addenda open until/)).toBeTruthy();
      const save = within(p).getByRole("button", { name: "Save addendum" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      fireEvent.change(addComposer(p), { target: { value: "Late text" } });
      expect(save.disabled).toBe(true); // reason still blank
      fireEvent.change(reasonBox(p), { target: { value: "   " } });
      expect(save.disabled).toBe(true);
      fireEvent.change(reasonBox(p), { target: { value: "Lab result arrived" } });
      expect(within(p).getByText("18 / 500")).toBeTruthy();
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
      expect(await within(p).findByText("Late text")).toBeTruthy();
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        patientId: P1,
        discipline: "msw",
        bodyText: "Late text",
        reason: "Lab result arrived",
      });
      expect(within(p).getByText("Late addendum")).toBeTruthy();
      expect(within(p).getByText("Reason: Lab result arrived")).toBeTruthy();
      expect(within(p).queryByRole("button", { name: "Edit" })).toBeNull();
      expect(reasonBox(p).value).toBe("");
    });

    it("renders originals before addenda with pill, recorded-at and reason", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(1);
      notes = [
        note({
          id: "a-1",
          discipline: "msw",
          bodyText: "Addendum text",
          isAddendum: true,
          addendumRecordedAt: "2026-08-28T08:00:00.000Z",
          reason: "Family called back",
        }),
        note({ id: "o-1", discipline: "msw", bodyText: "Original text" }),
      ];
      mount();
      const p = await panel();
      await within(p).findByText("Original text");
      const items = within(p).getAllByRole("listitem");
      expect(items[0]?.textContent).toContain("Original text");
      expect(items[1]?.textContent).toContain("Late addendum");
      expect(items[1]?.textContent).toContain("Reason: Family called back");
    });

    it("window closed: composer disabled with the closed date, still no Edit", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(20);
      notes = [note({ id: "n-2", discipline: "msw", bodyText: "Kept readable" })];
      mount();
      const p = await panel();
      expect(await within(p).findByText("Kept readable")).toBeTruthy();
      expect(within(p).getByText(/Addendum window closed/)).toBeTruthy();
      expect(within(p).queryByLabelText("Reason for the late addendum")).toBeNull();
      expect(composer(p).disabled).toBe(true);
      expect(
        (within(p).getByRole("button", { name: "Save note" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(within(p).queryByRole("button", { name: "Edit" })).toBeNull();
    });

    it("shows the server's addendum errors inline", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(2);
      postResponse = () => json({ error: { code: "ADDENDUM_WINDOW_CLOSED", message: "x" } }, 422);
      mount();
      const p = await panel();
      await within(p).findByText(/No MSW notes yet/);
      fireEvent.change(addComposer(p), { target: { value: "t" } });
      fireEvent.change(reasonBox(p), { target: { value: "r" } });
      fireEvent.click(within(p).getByRole("button", { name: "Save addendum" }));
      expect((await within(p).findByRole("alert")).textContent).toContain(
        "window for late addenda",
      );
      expect(addComposer(p).value).toBe("t");
    });

    it("never shows the text or reason of a withheld Part 2 addendum", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(2);
      notes = [
        note({
          id: "w-1",
          discipline: "msw",
          bodyText: null,
          bodyWithheld: true,
          isAddendum: true,
          addendumRecordedAt: at,
          reason: null,
        }),
      ];
      mount();
      const p = await panel();
      expect(await within(p).findByText("Withheld — Part 2")).toBeTruthy();
      expect(within(p).getByText("Late addendum")).toBeTruthy();
      expect(p.textContent).not.toContain("Reason:");
    });

    it("a live meeting shows the optional reason field, not the addendum one", async () => {
      mount();
      const p = await panel();
      expect(within(p).queryByLabelText("Reason for the late addendum")).toBeNull();
      expect(within(p).getByLabelText("Context / reason (optional)")).toBeTruthy();
    });

    it("addendumState.closesAt drives the open notice and a closed state overrides the date", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(2); // date maths would say open
      addendumState = {
        open: false,
        closesAt: "2026-09-01T00:00:00.000Z",
        closedReason: "window_elapsed",
        supersededPatientIds: [],
      };
      mount();
      const p = await panel();
      expect(
        await within(p).findByText(/Addendum window closed Aug 31, 2026|Sep 1, 2026/),
      ).toBeTruthy();
      expect(composer(p).disabled).toBe(true);
    });

    it("superseded patient: composer disabled with the explanation; meeting-level scope stays open", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(2);
      addendumState = {
        open: true,
        closesAt: daysAgo(-12),
        closedReason: null,
        supersededPatientIds: [P1],
      };
      mount();
      const p = await panel();
      expect(await within(p).findByText(/A newer IDG has adjourned for this patient/)).toBeTruthy();
      expect(addComposer(p).disabled).toBe(true);
      expect(
        (within(p).getByRole("button", { name: "Save addendum" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.click(within(p).getByRole("button", { name: /Meeting-level/ }));
      expect(within(p).queryByText(/A newer IDG has adjourned/)).toBeNull();
      expect(addComposer(p).disabled).toBe(false);
    });

    it("maps 422 ADDENDUM_SUPERSEDED_BY_NEWER_IDG inline and 503 ADDENDUM_ELIGIBILITY_UNAVAILABLE as retryable, keeping the draft", async () => {
      status = "adjourned";
      adjournedAt = daysAgo(2);
      mount();
      const p = await panel();
      await within(p).findByText(/No MSW notes yet/);
      fireEvent.change(addComposer(p), { target: { value: "draft" } });
      fireEvent.change(reasonBox(p), { target: { value: "why" } });
      postResponse = () =>
        json({ error: { code: "ADDENDUM_SUPERSEDED_BY_NEWER_IDG", message: "x" } }, 422);
      fireEvent.click(within(p).getByRole("button", { name: "Save addendum" }));
      expect((await within(p).findByRole("alert")).textContent).toContain(
        "A newer IDG has adjourned for this patient",
      );
      postResponse = () =>
        json({ error: { code: "ADDENDUM_ELIGIBILITY_UNAVAILABLE", message: "x" } }, 503);
      fireEvent.click(within(p).getByRole("button", { name: "Save addendum" }));
      await waitFor(() =>
        expect(within(p).getByRole("alert").textContent).toContain(
          "Could not verify addendum eligibility — try again.",
        ),
      );
      expect(addComposer(p).value).toBe("draft");
      expect(reasonBox(p).value).toBe("why");
    });
  });
});
