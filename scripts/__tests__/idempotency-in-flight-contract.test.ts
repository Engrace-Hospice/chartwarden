// The UI keeps an Idempotency-Key across the 409 that says "an earlier request under this key is still being processed" (a retry on a
// NEW key would run the write a second time). It recognises that 409 by what the server sends, which is hard-coded in the UI leaf
// (packages/ui/src/core/ops-write/idempotency-key.ts). This pins the two together: if the server's in-flight error changes its message
// or status, the UI would quietly start renewing the key on it, and a duplicate write would follow; this fails first.
import { describe, expect, it } from "vitest";
import {
  IdempotencyInFlightError,
  IdempotencyKeyStuckError,
} from "../../packages/shared/src/idempotency/idempotency";
import {
  IDEMPOTENCY_IN_FLIGHT_CODE,
  IDEMPOTENCY_KEY_STUCK_CODE,
  LEGACY_IN_FLIGHT_MESSAGE,
  isInFlightDuplicate,
  isKeyStuck,
  keepsKey,
} from "../../packages/ui/src/core/ops-write/idempotency-key";

describe("the server's in-flight Idempotency-Key error and the UI's reading of it", () => {
  const error = new IdempotencyInFlightError("a-key");
  /** The standard envelope the error handler renders for a ChartWardenError (apps/backend error-handler.ts). */
  const envelope = { error: { code: error.code, message: error.message } };

  it("is a 409 whose message is the one the UI's deploy-window stopgap matches", () => {
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe(LEGACY_IN_FLIGHT_MESSAGE);
    expect(error.code).toBe(IDEMPOTENCY_IN_FLIGHT_CODE);
  });

  it("is recognised by the UI as an in-flight duplicate, so the key is kept", () => {
    expect(isInFlightDuplicate(error.statusCode, envelope)).toBe(true);
  });

  it("is not confused with the server's other idempotency conflict (a different body under the key)", () => {
    expect(
      isInFlightDuplicate(409, {
        error: { code: "IDEMPOTENCY_CONFLICT", message: "different body" },
      }),
    ).toBe(false);
  });

  it("reads the two coded answers slice A adds, as the UI expects them: in flight keeps the key, a stuck key does not", () => {
    const code = (value: string) => ({ error: { code: value, message: "m" } });
    expect(IDEMPOTENCY_IN_FLIGHT_CODE).toBe("IDEMPOTENCY_IN_FLIGHT");
    expect(IDEMPOTENCY_KEY_STUCK_CODE).toBe("IDEMPOTENCY_KEY_STUCK");
    expect(keepsKey(409, code(IDEMPOTENCY_IN_FLIGHT_CODE))).toBe(true);
    expect(isKeyStuck(409, code(IDEMPOTENCY_KEY_STUCK_CODE))).toBe(true);
    expect(keepsKey(409, code(IDEMPOTENCY_KEY_STUCK_CODE))).toBe(false);
  });

  it("cross-checks both coded server errors against the UI variants", () => {
    const inFlight = new IdempotencyInFlightError("in-flight-key");
    const stuck = new IdempotencyKeyStuckError("stuck-key");

    expect(inFlight.code).toBe(IDEMPOTENCY_IN_FLIGHT_CODE);
    expect(inFlight.statusCode).toBe(409);
    expect(stuck.code).toBe(IDEMPOTENCY_KEY_STUCK_CODE);
    expect(stuck.statusCode).toBe(409);
  });
});
