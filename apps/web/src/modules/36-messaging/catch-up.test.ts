import { describe, expect, it, vi } from "vitest";
import { type CatchUpPage, catchUp, catchUpIfNeeded, needsCatchUp } from "./catch-up";
import type { Message } from "./messaging-types";

const msg = (id: string) => ({ messageId: id }) as unknown as Message;
const page = (ids: string[], nextCursor: string | null): CatchUpPage => ({
  messages: ids.map(msg),
  nextCursor,
});
const ids = (messages: readonly Message[]) => messages.map((m) => m.messageId);

describe("catchUp", () => {
  it("makes no extra read when the first page already overlaps a known id", async () => {
    const fetchOlder = vi.fn();
    const result = await catchUp(fetchOlder, new Set(["a"]), page(["c", "b", "a"], "c1"));
    expect(fetchOlder).not.toHaveBeenCalled();
    expect(result).toEqual({ messages: page(["c", "b", "a"], null).messages, gap: false });
  });

  it("pages backward with the opaque cursor until a page overlaps", async () => {
    const pages: Record<string, CatchUpPage> = {
      c1: page(["d", "c"], "c2"),
      c2: page(["b", "a"], "c3"),
    };
    const fetchOlder = vi.fn(async (cursor: string) => pages[cursor] ?? null);
    const result = await catchUp(fetchOlder, new Set(["a"]), page(["f", "e"], "c1"));
    expect(fetchOlder.mock.calls.map(([cursor]) => cursor)).toEqual(["c1", "c2"]);
    expect(ids(result.messages)).toEqual(["f", "e", "d", "c", "b", "a"]);
    expect(result.gap).toBe(false);
  });

  it("reports a gap when maxPages runs out before an overlap", async () => {
    const fetchOlder = vi.fn(async (cursor: string) => page([`m${cursor}`], `${cursor}x`));
    const result = await catchUp(fetchOlder, new Set(["never"]), page(["f"], "c"), 3);
    expect(fetchOlder).toHaveBeenCalledTimes(2); // first page + 2 older = 3 pages
    expect(result.gap).toBe(true);
    expect(result.messages).toHaveLength(3);
  });

  it("reports a gap, keeping what it has, when an older read fails", async () => {
    const result = await catchUp(async () => null, new Set(["a"]), page(["f"], "c1"));
    expect(ids(result.messages)).toEqual(["f"]);
    expect(result.gap).toBe(true);
  });

  it("reports no gap when the conversation start is reached without meeting a known id", async () => {
    const result = await catchUp(async () => page(["a0"], null), new Set(["x"]), page(["f"], "c1"));
    expect(ids(result.messages)).toEqual(["f", "a0"]);
    expect(result.gap).toBe(false);
  });
});

describe("catchUp staleness and network failure", () => {
  it("stops requesting pages once isStale() turns true", async () => {
    let stale = false;
    const fetchOlder = vi.fn(async (cursor: string) => {
      stale = true; // the channel switches while the first older page is in flight
      return page([`m${cursor}`], `${cursor}x`);
    });
    const result = await catchUp(fetchOlder, new Set(["never"]), page(["f"], "c"), 5, () => stale);
    expect(fetchOlder).toHaveBeenCalledTimes(1);
    expect(result.gap).toBe(true);
  });

  it("keeps the first page and flags a gap when the older-page GET rejects (TypeError)", async () => {
    const get = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const client = { GET: get } as unknown as Parameters<typeof catchUpIfNeeded>[0];
    const result = await catchUpIfNeeded(client, "ch", [msg("a")], {
      messages: [msg("f"), msg("e")],
      nextCursor: "c1",
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(result && ids(result.messages)).toEqual(["f", "e"]);
    expect(result?.gap).toBe(true);
  });
});

describe("needsCatchUp", () => {
  it("is false before anything is loaded and when the page overlaps, true when it does not", () => {
    expect(needsCatchUp(null, [msg("a")])).toBe(false);
    expect(needsCatchUp([], [msg("a")])).toBe(false);
    expect(needsCatchUp([msg("a")], [msg("a"), msg("b")])).toBe(false);
    expect(needsCatchUp([msg("a")], [msg("c"), msg("b")])).toBe(true);
  });
});
