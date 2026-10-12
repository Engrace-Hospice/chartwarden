import { describe, expect, it } from "vitest";
import { rotateIdempotencyKey, sendAttemptFor } from "./messaging-utils";

describe("WP 1.2 send attempt identity", () => {
  it("mints a client id and an idempotency key for a new composed message", () => {
    const attempt = sendAttemptFor(null, "ch|hello");
    expect(attempt.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(attempt.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses both ids on a retry of the same composed message", () => {
    const first = sendAttemptFor(null, "ch|hello");
    expect(sendAttemptFor(first, "ch|hello")).toBe(first);
  });

  it("mints fresh ids once the composed message changes", () => {
    const first = sendAttemptFor(null, "ch|hello");
    const edited = sendAttemptFor(first, "ch|hello world");
    expect(edited.clientMessageId).not.toBe(first.clientMessageId);
    expect(edited.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("rotates only the header key, keeping the client message id", () => {
    const first = sendAttemptFor(null, "ch|hello");
    const rotated = rotateIdempotencyKey(first);
    expect(rotated.clientMessageId).toBe(first.clientMessageId);
    expect(rotated.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(rotated.fingerprint).toBe(first.fingerprint);
  });
});
