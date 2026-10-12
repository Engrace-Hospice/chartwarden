import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type MessagingSocketFactory, useMessagingRealtime } from "./use-messaging-realtime";

function fakeSocket() {
  const handlers = new Map<string, (payload?: unknown) => void>();
  const socket = {
    on: vi.fn((event: string, fn: (payload?: unknown) => void) => handlers.set(event, fn)),
    off: vi.fn((event: string) => handlers.delete(event)),
    close: vi.fn(),
  };
  const emit = (event: string, payload?: unknown) => act(() => handlers.get(event)?.(payload));
  return { socket, emit, factory: (() => socket) as unknown as MessagingSocketFactory };
}

const hint = (cursor: string, channelId = "ch1") => ({
  kind: "message.new",
  cursor,
  ids: { channelId, messageId: "m1" },
});

describe("useMessagingRealtime", () => {
  it("reports connection state and syncs on every reconnect, not the first connect", () => {
    const { emit, factory } = fakeSocket();
    const onSync = vi.fn();
    const { result } = renderHook(() => useMessagingRealtime(vi.fn(), onSync, factory));
    expect(result.current).toBe(false);
    emit("connect");
    expect(result.current).toBe(true);
    emit("disconnect");
    expect(result.current).toBe(false);
    emit("connect");
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("delivers a hint once per cursor and ignores malformed payloads", () => {
    const { emit, factory } = fakeSocket();
    const onHint = vi.fn();
    renderHook(() => useMessagingRealtime(onHint, vi.fn(), factory));
    emit("hint", hint("c1"));
    emit("hint", hint("c1"));
    emit("hint", hint("c2"));
    emit("hint", { cursor: 5 });
    emit("hint", null);
    expect(onHint.mock.calls.map(([h]) => h.cursor)).toEqual(["c1", "c2"]);
  });

  it("forgets seen cursors on reconnect so a restarted server's cursor is not swallowed", () => {
    const { emit, factory } = fakeSocket();
    const onHint = vi.fn();
    renderHook(() => useMessagingRealtime(onHint, vi.fn(), factory));
    emit("connect");
    emit("hint", hint("c1"));
    emit("disconnect");
    emit("connect");
    emit("hint", hint("c1"));
    expect(onHint).toHaveBeenCalledTimes(2);
  });

  it("closes the socket on unmount", () => {
    const { socket, factory } = fakeSocket();
    const { unmount } = renderHook(() => useMessagingRealtime(vi.fn(), vi.fn(), factory));
    unmount();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
