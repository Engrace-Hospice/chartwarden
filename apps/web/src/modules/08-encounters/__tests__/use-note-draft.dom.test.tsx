// The visit-note draft hook (ADR-0114): what a resolve in flight may and may not touch, and what counts as a readable draft.
// The net asserts on recorded fetch calls. Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { DraftSectionView } from "../draft-api";
import { useNoteDraft } from "../use-note-draft";
import { type Call, type Responder, makeFetch } from "./closure-test-harness";

const ENC_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENC_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const CORPUS = "2026.1.0";

type Section = DraftSectionView;

const drafted = (text: string, state: Section["state"] = "unresolved"): Section => ({
  sectionId: "plan",
  state,
  text,
  contentHash: `hash-${text}`,
  corpusVersion: CORPUS,
  part2Derived: false,
  origins: ["care_plan_goal"],
});

const draftOf = (encounterId: string, section: Section) => ({
  encounterId,
  patientId: "patient-1",
  templateKey: "routine_visit:rn",
  asOf: "2026-11-17T23:59:59.999Z",
  sections: [section],
});

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}
function gate(): Gate {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function setup(routes: Record<string, Responder>, initialId: string | undefined = ENC_A) {
  const calls: Call[] = [];
  const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(routes, calls) });
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
  const view = renderHook(({ id }: { id: string | undefined }) => useNoteDraft(id), {
    wrapper,
    initialProps: { id: initialId },
  });
  return { ...view, calls };
}

const textOf = (draft: ReturnType<typeof useNoteDraft>["load"]): string | null =>
  draft.status === "ready" ? (draft.draft.sections[0]?.text ?? null) : null;

describe("a resolve in flight when the encounter changes", () => {
  it("never writes the old encounter's section or note into the new one, and frees the new one to resolve", async () => {
    const putA = gate();
    const routes: Record<string, Responder> = {
      [`GET /api/v1/encounters/${ENC_A}/draft`]: () => ({
        body: draftOf(ENC_A, drafted("Patient A goal.")),
      }),
      [`GET /api/v1/encounters/${ENC_B}/draft`]: () => ({
        body: draftOf(ENC_B, drafted("Patient B goal.")),
      }),
      [`PUT /api/v1/encounters/${ENC_A}/draft/sections/plan`]: async () => {
        await putA.promise;
        return { body: drafted("Patient A goal.", "confirmed") };
      },
      [`PUT /api/v1/encounters/${ENC_B}/draft/sections/plan`]: () => ({
        body: drafted("Patient B goal.", "confirmed"),
      }),
    };
    const { result, rerender } = setup(routes);
    await waitFor(() => expect(textOf(result.current.load)).toBe("Patient A goal."));
    const sectionA = (result.current.load as { draft: { sections: Section[] } }).draft
      .sections[0] as Section;

    let resolved: Promise<boolean> = Promise.resolve(true);
    act(() => {
      resolved = result.current.resolve(sectionA, "confirmed");
    });
    await waitFor(() => expect(result.current.busySectionId).toBe("plan"));

    rerender({ id: ENC_B });
    await waitFor(() => expect(textOf(result.current.load)).toBe("Patient B goal."));
    expect(result.current.busySectionId).toBeNull();

    // A's answer lands after the switch: B keeps its own draft, gets no note, and the late resolve reports nothing recorded here.
    putA.open();
    expect(await resolved).toBe(false);
    expect(textOf(result.current.load)).toBe("Patient B goal.");
    expect(result.current.notes).toEqual({});
    expect(result.current.busySectionId).toBeNull();

    // And B may resolve its own section: A's late answer did not leave the in-flight guard stuck or cleared it under B.
    const sectionB = (result.current.load as { draft: { sections: Section[] } }).draft
      .sections[0] as Section;
    let recorded = false;
    await act(async () => {
      recorded = await result.current.resolve(sectionB, "confirmed");
    });
    expect(recorded).toBe(true);
    expect(result.current.notes.plan?.text).toMatch(/confirmed/i);
  });

  it("does not let the old answer clear the guard of a resolve the new encounter started", async () => {
    const putA = gate();
    const putB = gate();
    const routes: Record<string, Responder> = {
      [`GET /api/v1/encounters/${ENC_A}/draft`]: () => ({ body: draftOf(ENC_A, drafted("A.")) }),
      [`GET /api/v1/encounters/${ENC_B}/draft`]: () => ({ body: draftOf(ENC_B, drafted("B.")) }),
      [`PUT /api/v1/encounters/${ENC_A}/draft/sections/plan`]: async () => {
        await putA.promise;
        return { body: drafted("A.", "confirmed") };
      },
      [`PUT /api/v1/encounters/${ENC_B}/draft/sections/plan`]: async () => {
        await putB.promise;
        return { body: drafted("B.", "confirmed") };
      },
    };
    const { result, rerender, calls } = setup(routes);
    await waitFor(() => expect(textOf(result.current.load)).toBe("A."));
    const sectionA = (result.current.load as { draft: { sections: Section[] } }).draft
      .sections[0] as Section;
    let resolvedA: Promise<boolean> = Promise.resolve(true);
    act(() => {
      resolvedA = result.current.resolve(sectionA, "confirmed");
    });
    rerender({ id: ENC_B });
    await waitFor(() => expect(textOf(result.current.load)).toBe("B."));
    const sectionB = (result.current.load as { draft: { sections: Section[] } }).draft
      .sections[0] as Section;
    let resolvedB: Promise<boolean> = Promise.resolve(false);
    act(() => {
      resolvedB = result.current.resolve(sectionB, "confirmed");
    });
    await waitFor(() => expect(result.current.busySectionId).toBe("plan"));

    putA.open();
    await resolvedA;
    // B's resolve is still in flight: a second click must not send a second request.
    expect(result.current.busySectionId).toBe("plan");
    await act(async () => {
      expect(await result.current.resolve(sectionB, "deselected")).toBe(false);
    });
    expect(calls.filter((c) => c.method === "PUT" && c.path.includes(ENC_B))).toHaveLength(1);

    putB.open();
    expect(await resolvedB).toBe(true);
  });
});

describe("a re-read asked for while a resolve is in flight", () => {
  it("waits for the resolve to land, then reads once, so an older read cannot overwrite the recorded section", async () => {
    const putGate = gate();
    let committed = false;
    const routes: Record<string, Responder> = {
      [`GET /api/v1/encounters/${ENC_A}/draft`]: () => ({
        body: draftOf(ENC_A, drafted("Goal.", committed ? "confirmed" : "unresolved")),
      }),
      [`PUT /api/v1/encounters/${ENC_A}/draft/sections/plan`]: async () => {
        await putGate.promise;
        committed = true;
        return { body: drafted("Goal.", "confirmed") };
      },
    };
    const { result, calls } = setup(routes);
    await waitFor(() => expect(result.current.load.status).toBe("ready"));
    const section = (result.current.load as { draft: { sections: Section[] } }).draft
      .sections[0] as Section;
    const readsBefore = calls.filter((c) => c.method === "GET").length;

    let resolved: Promise<boolean> = Promise.resolve(false);
    act(() => {
      resolved = result.current.resolve(section, "confirmed");
    });
    await act(async () => {
      await result.current.reload();
    });
    // The re-read did not go out while the PUT was in flight.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(readsBefore);

    putGate.open();
    expect(await resolved).toBe(true);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(readsBefore + 1),
    );
    await waitFor(() =>
      expect(
        result.current.load.status === "ready" && result.current.load.draft.sections[0]?.state,
      ).toBe("confirmed"),
    );
    expect(result.current.notes.plan?.text).toMatch(/confirmed/i);
  });
});

describe("reading the draft", () => {
  const readOnly = (body: unknown) =>
    setup({ [`GET /api/v1/encounters/${ENC_A}/draft`]: () => ({ body }) });

  it("says unavailable, not a crash, for a 200 whose body is null", async () => {
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async () =>
        new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
    });
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    );
    const { result } = renderHook(() => useNoteDraft(ENC_A), { wrapper });
    await waitFor(() => expect(result.current.load.status).toBe("unavailable"));
  });

  it("says unavailable for a 200 that is not a draft (no sections list)", async () => {
    const { result } = readOnly({ encounterId: ENC_A });
    await waitFor(() => expect(result.current.load.status).toBe("unavailable"));
  });

  it("says unavailable for a section with a state the screens do not know", async () => {
    const { result } = readOnly(
      draftOf(ENC_A, { ...drafted("Goal."), state: "approved" } as never),
    );
    await waitFor(() => expect(result.current.load.status).toBe("unavailable"));
  });

  it("says unavailable for a section with no origins", async () => {
    const { result } = readOnly(
      draftOf(ENC_A, { ...drafted("Goal."), origins: undefined } as never),
    );
    await waitFor(() => expect(result.current.load.status).toBe("unavailable"));
  });

  it("stays off for the note's own 403 (a role without the read): only an addendum's draft is its author's alone", async () => {
    const { result } = setup({
      [`GET /api/v1/encounters/${ENC_A}/draft`]: () => ({
        status: 403,
        body: { error: { code: "FORBIDDEN" } },
      }),
    });
    await waitFor(() => expect(result.current.load.status).toBe("off"));
  });

  it("reports when a re-read is in flight", async () => {
    const second = gate();
    let reads = 0;
    const { result } = setup({
      [`GET /api/v1/encounters/${ENC_A}/draft`]: async () => {
        reads += 1;
        if (reads > 1) await second.promise;
        return { body: draftOf(ENC_A, drafted("Goal.")) };
      },
    });
    await waitFor(() => expect(result.current.load.status).toBe("ready"));
    expect(result.current.refreshing).toBe(false);
    let reload: Promise<unknown> = Promise.resolve();
    act(() => {
      reload = result.current.reload();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    second.open();
    await act(async () => {
      await reload;
    });
    expect(result.current.refreshing).toBe(false);
  });
});

describe("a resolve asked for while the draft is being read again", () => {
  it("records nothing: the text on screen may be about to change, so the PUT is not sent", async () => {
    const second = gate();
    let reads = 0;
    const { result, calls } = setup({
      [`GET /api/v1/encounters/${ENC_A}/draft`]: async () => {
        reads += 1;
        if (reads > 1) await second.promise;
        return { body: draftOf(ENC_A, drafted("Goal.")) };
      },
      [`PUT /api/v1/encounters/${ENC_A}/draft/sections/plan`]: () => ({
        body: drafted("Goal.", "confirmed"),
      }),
    });
    await waitFor(() => expect(result.current.load.status).toBe("ready"));
    const section = (result.current.load as { draft: { sections: Section[] } }).draft
      .sections[0] as Section;
    let reload: Promise<unknown> = Promise.resolve();
    act(() => {
      reload = result.current.reload();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(true));

    let recorded = true;
    await act(async () => {
      recorded = await result.current.resolve(section, "confirmed");
    });
    expect(recorded).toBe(false);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);

    second.open();
    await act(async () => {
      await reload;
    });
    // Once the read has landed, the same resolve is sent.
    await act(async () => {
      recorded = await result.current.resolve(section, "confirmed");
    });
    expect(recorded).toBe(true);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });
});

// An amending addendum's own draft (ADR-0114 VN-D30): the same hook, read and resolved through the addendum's routes, so the note's
// draft and the addendum's never mix.
describe("the draft of an amending addendum", () => {
  const ADDENDUM = "cccccccc-3333-4333-8333-cccccccccccc";
  const DRAFT_ROUTE = `GET /api/v1/encounters/${ENC_A}/addenda/${ADDENDUM}/draft`;
  const PUT_ROUTE = `PUT /api/v1/encounters/${ENC_A}/addenda/${ADDENDUM}/draft/sections/plan`;

  function setupAddendum(routes: Record<string, Responder>) {
    const calls: Call[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: makeFetch(routes, calls),
    });
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    );
    const view = renderHook(() => useNoteDraft(ENC_A, "", ADDENDUM), { wrapper });
    return { ...view, calls };
  }

  it("reads and resolves a section through the addendum's own routes, never the note's", async () => {
    const { result, calls } = setupAddendum({
      [DRAFT_ROUTE]: () => ({
        body: { ...draftOf(ENC_A, drafted("Amended goal.")), addendumId: ADDENDUM },
      }),
      [PUT_ROUTE]: () => ({ body: drafted("Amended goal.", "confirmed") }),
    });
    await waitFor(() => expect(textOf(result.current.load)).toBe("Amended goal."));
    const section = (result.current.load as { draft: { sections: Section[] } }).draft
      .sections[0] as Section;
    await act(async () => {
      await result.current.resolve(section, "confirmed");
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/v1/encounters/${ENC_A}/addenda/${ADDENDUM}/draft`,
      `PUT /api/v1/encounters/${ENC_A}/addenda/${ADDENDUM}/draft/sections/plan`,
    ]);
    expect(calls[1]?.body).toEqual({
      resolution: "confirmed",
      contentHash: "hash-Amended goal.",
      corpusVersion: CORPUS,
    });
    await waitFor(() =>
      expect(
        (result.current.load as { draft: { sections: Section[] } }).draft.sections[0]?.state,
      ).toBe("confirmed"),
    );
  });

  it("is off for a 404 (the draft switch is off, or the addendum names no section)", async () => {
    const { result } = setupAddendum({
      [DRAFT_ROUTE]: () => ({ status: 404, body: { error: { code: "NOT_FOUND" } } }),
    });
    await waitFor(() => expect(result.current.load.status).toBe("off"));
  });

  it("is 'notAuthor' for a 403: the addendum's draft is its author's alone, and no server text is kept", async () => {
    const { result } = setupAddendum({
      [DRAFT_ROUTE]: () => ({
        status: 403,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "only the author of the addendum may read its draft",
          },
        },
      }),
    });
    await waitFor(() => expect(result.current.load.status).toBe("notAuthor"));
    expect(JSON.stringify(result.current.load)).not.toMatch(/only the author of the addendum/);
  });

  it("reads nothing while the addendum is not known", async () => {
    const calls: Call[] = [];
    const client = createApiClient({ baseUrl: "http://localhost", fetch: makeFetch({}, calls) });
    renderHook(() => useNoteDraft(undefined, "", "any"), {
      wrapper: ({ children }: { children: ReactNode }): JSX.Element => (
        <ApiClientProvider client={client}>{children}</ApiClientProvider>
      ),
    });
    expect(calls).toEqual([]);
  });
});
