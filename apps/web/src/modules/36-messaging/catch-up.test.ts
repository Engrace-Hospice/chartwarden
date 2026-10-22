import { describe, expect, it, vi } from "vitest";
import { type CatchUpPage, catchUp, needsCatchUp } from "./catch-up";
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

describe("needsCatchUp", () => {
  it("is false before anything is loaded and when the page overlaps, true when it does not", () => {
    expect(needsCatchUp(null, [msg("a")])).toBe(false);
    expect(needsCatchUp([], [msg("a")])).toBe(false);
    expect(needsCatchUp([msg("a")], [msg("a"), msg("b")])).toBe(false);
    expect(needsCatchUp([msg("a")], [msg("c"), msg("b")])).toBe(true);
  });
});
