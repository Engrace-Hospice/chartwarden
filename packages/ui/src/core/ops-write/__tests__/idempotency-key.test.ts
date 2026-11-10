// The one rule for when an attempt's Idempotency-Key survives its answer, shared by the API client's middleware and `sendWrite`.
import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_IN_FLIGHT_CODE,
  IDEMPOTENCY_KEY_MAX_AGE_MS,
  IDEMPOTENCY_KEY_STUCK_CODE,
  IDEMPOTENCY_KEY_TTL_MS,
  LEGACY_IN_FLIGHT_MESSAGE,
  freshIdempotencyKeyHeaders,
  isGatewayPage,
  isInFlightDuplicate,
  isKeyStuck,
  keepsKey,
  keyIdleTooLong,
  keyPastMaxAge,
  newIdempotencyKey,
} from "../idempotency-key";

const LEGACY_IN_FLIGHT = {
  error: { code: "CONFLICT", message: "Idempotency-Key request is still being processed" },
};
const GATEWAY_5XX = 502;

describe("isGatewayPage", () => {
  it("is a 5xx whose body is not the API error envelope", () => {
    expect(isGatewayPage(GATEWAY_5XX, "<html>Bad gateway</html>")).toBe(true);
    expect(isGatewayPage(GATEWAY_5XX, undefined)).toBe(true);
    expect(isGatewayPage(503, null)).toBe(true);
    expect(isGatewayPage(500, { error: {} })).toBe(true);
    expect(isGatewayPage(500, { error: { code: 5 } })).toBe(true);
    expect(isGatewayPage(500, { error: "text" })).toBe(true);
    expect(isGatewayPage(500, { message: "busy" })).toBe(true);
  });

  it("is not a 5xx the app answered, nor any status below 500", () => {
    expect(isGatewayPage(500, { error: { code: "PERSIST_FAILED" } })).toBe(false);
    expect(isGatewayPage(409, undefined)).toBe(false);
    expect(isGatewayPage(404, "<html>gone</html>")).toBe(false);
    expect(isGatewayPage(200, undefined)).toBe(false);
  });
});

describe("isInFlightDuplicate", () => {
  it("is the 409 IDEMPOTENCY_IN_FLIGHT code", () => {
    expect(isInFlightDuplicate(409, { error: { code: IDEMPOTENCY_IN_FLIGHT_CODE } })).toBe(true);
  });

  it("is, for the deploy window, the plain 409 CONFLICT an older server sends with its exact message", () => {
    expect(isInFlightDuplicate(409, LEGACY_IN_FLIGHT)).toBe(true);
  });

  it("is not any other 409, nor the same code on another status", () => {
    expect(isInFlightDuplicate(409, { error: { code: "CONFLICT", message: "Plan exists" } })).toBe(
      false,
    );
    expect(isInFlightDuplicate(409, { error: { code: "CONFLICT" } })).toBe(false);
    expect(isInFlightDuplicate(409, { error: { code: "IDEMPOTENCY_CONFLICT" } })).toBe(false);
    expect(isInFlightDuplicate(409, { error: { code: "CONCURRENT_UPDATE" } })).toBe(false);
    expect(isInFlightDuplicate(409, undefined)).toBe(false);
    expect(isInFlightDuplicate(409, "Idempotency-Key request is still being processed")).toBe(
      false,
    );
    expect(isInFlightDuplicate(422, { error: { code: IDEMPOTENCY_IN_FLIGHT_CODE } })).toBe(false);
    expect(isInFlightDuplicate(200, LEGACY_IN_FLIGHT)).toBe(false);
  });
});

describe("isKeyStuck", () => {
  it("is the 409 IDEMPOTENCY_KEY_STUCK code: the server says the first request under this key never finished and its outcome is unknown", () => {
    expect(isKeyStuck(409, { error: { code: IDEMPOTENCY_KEY_STUCK_CODE, message: "m" } })).toBe(
      true,
    );
  });

  it("is not any other 409, nor the in-flight duplicate, nor the same code on another status", () => {
    expect(isKeyStuck(409, { error: { code: IDEMPOTENCY_IN_FLIGHT_CODE } })).toBe(false);
    expect(isKeyStuck(409, LEGACY_IN_FLIGHT)).toBe(false);
    expect(isKeyStuck(409, { error: { code: "CONFLICT" } })).toBe(false);
    expect(isKeyStuck(409, undefined)).toBe(false);
    expect(isKeyStuck(500, { error: { code: IDEMPOTENCY_KEY_STUCK_CODE } })).toBe(false);
  });

  it("is never an in-flight duplicate: it is a final answer for that key, so the key is not kept", () => {
    const body = { error: { code: IDEMPOTENCY_KEY_STUCK_CODE, message: "m" } };
    expect(isInFlightDuplicate(409, body)).toBe(false);
    expect(keepsKey(409, body)).toBe(false);
  });
});

describe("keepsKey: the intended contract, case by case", () => {
  it.each([
    [GATEWAY_5XX, "<html>Bad gateway</html>", true, "a gateway page that never reached the app"],
    [504, undefined, true, "an empty gateway timeout"],
    [409, { error: { code: IDEMPOTENCY_IN_FLIGHT_CODE } }, true, "an in-flight duplicate"],
    [409, LEGACY_IN_FLIGHT, true, "an in-flight duplicate from an older server"],
    [
      409,
      { error: { code: IDEMPOTENCY_KEY_STUCK_CODE } },
      false,
      "a stuck key (a final answer for that key)",
    ],
    [200, {}, false, "a success"],
    [204, undefined, false, "a success with no body"],
    [403, { error: { code: "STEP_UP_REQUIRED" } }, false, "a cached-refusal-to-be (403)"],
    [409, { error: { code: "CONFLICT", message: "Plan exists" } }, false, "a business 409"],
    [409, { error: { code: "CONCURRENT_UPDATE" } }, false, "a retryable conflict the app answered"],
    [422, { error: { code: "VALIDATION_FAILED" } }, false, "a validation refusal"],
    [500, { error: { code: "INTERNAL" } }, false, "an app 5xx carrying the envelope"],
  ])("(%i, %j) -> %s: %s", (status, body, keeps, _label) => {
    expect(keepsKey(status, body)).toBe(keeps);
  });
});

describe("newIdempotencyKey", () => {
  it("is a new value each time", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe("freshIdempotencyKeyHeaders", () => {
  it("is one Idempotency-Key header, new on every call", () => {
    const first = freshIdempotencyKeyHeaders();
    const second = freshIdempotencyKeyHeaders();

    expect(Object.keys(first)).toEqual(["Idempotency-Key"]);
    expect(first["Idempotency-Key"]).toBeTruthy();
    expect(second["Idempotency-Key"]).not.toBe(first["Idempotency-Key"]);
  });
});

describe("the key's lifetime", () => {
  it("is idle-too-long exactly a TTL after the last unanswered attempt", () => {
    expect(keyIdleTooLong(1_000, 1_000 + IDEMPOTENCY_KEY_TTL_MS - 1)).toBe(false);
    expect(keyIdleTooLong(1_000, 1_000 + IDEMPOTENCY_KEY_TTL_MS)).toBe(true);
  });

  it("is past its age exactly the hard cap after the first attempt, regardless of retries", () => {
    expect(keyPastMaxAge(1_000, 1_000 + IDEMPOTENCY_KEY_MAX_AGE_MS - 1)).toBe(false);
    expect(keyPastMaxAge(1_000, 1_000 + IDEMPOTENCY_KEY_MAX_AGE_MS)).toBe(true);
    expect(IDEMPOTENCY_KEY_MAX_AGE_MS).toBeGreaterThan(IDEMPOTENCY_KEY_TTL_MS);
  });

  it("names the legacy in-flight sentence the older server sends", () => {
    expect(LEGACY_IN_FLIGHT_MESSAGE).toBe("Idempotency-Key request is still being processed");
  });
});
