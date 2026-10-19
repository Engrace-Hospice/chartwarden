// WP 4.8 - the remembered notification link: only an opaque `/n/<id>` is kept, the way back is rebuilt (never replayed), and a
// crafted value can neither be stored nor turn into an external redirect.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notificationIdFromPath,
  notificationPath,
  rememberPendingNotificationLink,
  takePendingNotificationLink,
} from "./pending-deep-link";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.useRealTimers());

describe("notification link memory", () => {
  it("keeps an opaque id and returns the rebuilt app path once", () => {
    rememberPendingNotificationLink("/n/3f2a_9-Zz");
    expect(takePendingNotificationLink()).toBe("/n/3f2a_9-Zz");
    expect(takePendingNotificationLink()).toBeNull();
  });

  it.each([
    "/messaging",
    "/n/",
    "/n/a/b",
    "/n/a?next=https://evil.example",
    "//evil.example/n/abc",
    "/\\evil.example",
    "https://evil.example/n/abc",
    "/n/abc%2f..",
    "/n/abc def",
    `/n/${"a".repeat(65)}`,
    "javascript:alert(1)",
  ])("never stores %s", (path) => {
    rememberPendingNotificationLink(path);
    expect(takePendingNotificationLink()).toBeNull();
  });

  it("rebuilds the path from the id, ignoring anything else in storage", () => {
    window.sessionStorage.setItem(
      "wx.pending-notification-link",
      JSON.stringify({ id: "//evil.example", at: Date.now() }),
    );
    expect(takePendingNotificationLink()).toBeNull();
    window.sessionStorage.setItem(
      "wx.pending-notification-link",
      JSON.stringify({ id: "abc", at: Date.now(), next: "https://evil.example" }),
    );
    expect(takePendingNotificationLink()).toBe("/n/abc");
  });

  it("forgets a link older than fifteen minutes and survives unreadable storage", () => {
    vi.useFakeTimers({ now: new Date("2026-10-18T10:00:00Z") });
    rememberPendingNotificationLink("/n/abc");
    vi.setSystemTime(new Date("2026-10-18T10:16:00Z"));
    expect(takePendingNotificationLink()).toBeNull();
    window.sessionStorage.setItem("wx.pending-notification-link", "{not json");
    expect(takePendingNotificationLink()).toBeNull();
  });

  it("maps a non-opaque id to the home page and an exact path to its id", () => {
    expect(notificationPath("a b")).toBe("/");
    expect(notificationIdFromPath("/n/abc/")).toBe("abc");
    expect(notificationIdFromPath("/x/n/abc")).toBeNull();
  });
});
