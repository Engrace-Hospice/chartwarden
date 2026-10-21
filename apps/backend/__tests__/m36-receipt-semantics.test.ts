// M36 WP 1.6 — receipt-semantics type pin. `message_receipt.status` is `delivered | read` only
// (ADR-0056 item 1: clinical acknowledgement lives in the Phase 4 message_acknowledgment_* tables, never
// on a receipt). This file is checked by `typecheck:tests`: an `@ts-expect-error` that stops erroring
// means `"ack"` became assignable again.
import { type DbClient, schema } from "@chartwarden/db";
import type { MessageReceiptStatus } from "@chartwarden/messaging";
import { describe, expect, it } from "vitest";

describe("M36 receipt semantics", () => {
  it("admits exactly delivered and read", () => {
    // @ts-expect-error — "ack" is retired from the receipt status union
    const retired: MessageReceiptStatus = "ack";
    const all: MessageReceiptStatus[] = ["delivered", "read"];
    expect(all).not.toContain(retired);
  });

  it("types the Drizzle status column as delivered | read", () => {
    // Compile-time only: the closure is never invoked.
    const compileOnly = (db: DbClient) => {
      // @ts-expect-error — the Drizzle column is typed delivered | read
      void db.update(schema.messageReceipts).set({ status: "ack" });
      void db.update(schema.messageReceipts).set({ status: "read", readAt: new Date() });
    };
    expect(typeof compileOnly).toBe("function");
  });
});
