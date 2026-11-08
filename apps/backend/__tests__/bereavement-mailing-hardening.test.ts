// apps/backend/__tests__/bereavement-mailing-hardening.test.ts — ADR-0109 D10 review follow-ups: the small pure guards the mailing worker and routes lean on.
import { Buffer } from "node:buffer";
import { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  BereavementCipherBlobError,
  createBereavementCipher,
} from "../src/modules/16-bereavement/bereavement-crypto";
import { addressLinesOf } from "../src/modules/16-bereavement/jobs/mailing-workers";
import { mailingGenerateJobId } from "../src/modules/16-bereavement/mailings/enqueue-port";
import {
  decodeCheckedCursor,
  encodeCursor,
} from "../src/modules/16-bereavement/routes/concurrency";
import { parse } from "../src/modules/16-bereavement/routes/m16-typebox";
import { PutMailingConfigBody } from "../src/modules/16-bereavement/routes/mailing-typebox";

const ORG = "a1610000-0000-4000-8000-0000000000a1";
const ID = "10000000-0000-4000-8000-0000000000f1";
const KEY = Buffer.alloc(32, 9);

describe("decodeCheckedCursor: a crafted cursor is a validation error, never a cast error", () => {
  it("accepts a cursor whose anchor and id have the shape the SQL casts them to", () => {
    expect(decodeCheckedCursor(encodeCursor({ a: "2026-10-15", id: ID }), "date")).toEqual({
      a: "2026-10-15",
      id: ID,
    });
    expect(
      decodeCheckedCursor(encodeCursor({ a: "2026-11-05T10:00:00.000Z", id: ID }), "instant")?.id,
    ).toBe(ID);
    expect(decodeCheckedCursor(encodeCursor({ a: "12", id: ID }), "integer")?.a).toBe("12");
    // the items' NULL-ordinal sentinel is int4 max itself, and is a cursor this route issues
    expect(decodeCheckedCursor(encodeCursor({ a: "2147483647", id: ID }), "integer")?.a).toBe(
      "2147483647",
    );
  });

  it("treats no cursor, and a cursor that is not base64 JSON, as the start of the list", () => {
    expect(decodeCheckedCursor(undefined, "date")).toBeNull();
    expect(decodeCheckedCursor("", "date")).toBeNull();
    expect(decodeCheckedCursor("%%%not-a-cursor", "date")).toBeNull();
  });

  it("refuses a well-formed cursor with a bad anchor or id (they would reach a ::uuid cast or new Date)", () => {
    for (const [anchor, bad] of [
      ["date", { a: "nope", id: ID }],
      ["date", { a: "2026-13-45", id: ID }],
      ["instant", { a: "not a time", id: ID }],
      ["integer", { a: "1; DROP TABLE x", id: ID }],
      // ten digits, but past a Postgres int4: it would be an out-of-range cast, not a validation error
      ["integer", { a: "2147483648", id: ID }],
      ["integer", { a: "9999999999", id: ID }],
      ["date", { a: "2026-10-15", id: "not-a-uuid" }],
      ["date", { a: "2026-10-15", id: "' OR 1=1 --" }],
    ] as const) {
      expect(() => decodeCheckedCursor(encodeCursor(bad), anchor), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
  });
});

describe("the tenant cipher separates a bad blob from a key-provider failure", () => {
  const healthy = createBereavementCipher({
    dekForOrg: async () => ({ version: "v1", key: KEY }),
    dekForOrgVersion: async () => ({ version: "v1", key: KEY }),
  });

  it("a blob that does not open is a typed BereavementCipherBlobError (garbage, wrong column, wrong org)", async () => {
    const sealed = await healthy.encrypt(
      ORG,
      "bereaved_contact.mailing_address",
      "10 Sample Street",
    );
    expect(await healthy.decrypt(ORG, "bereaved_contact.mailing_address", sealed)).toBe(
      "10 Sample Street",
    );
    await expect(
      healthy.decrypt(ORG, "bereaved_contact.mailing_address", "v1.v1.garbage.garbage.garbage"),
    ).rejects.toBeInstanceOf(BereavementCipherBlobError);
    await expect(
      healthy.decrypt(ORG, "bereaved_contact.mailing_address", "not-a-blob"),
    ).rejects.toBeInstanceOf(BereavementCipherBlobError);
    await expect(healthy.decrypt(ORG, "bereaved_contact.phone", sealed)).rejects.toBeInstanceOf(
      BereavementCipherBlobError,
    ); // lifted into another column
    await expect(
      healthy.decrypt(
        "b1610000-0000-4000-8000-0000000000b1",
        "bereaved_contact.mailing_address",
        sealed,
      ),
    ).rejects.toBeInstanceOf(BereavementCipherBlobError); // another org
  });

  it("a key-provider outage is NOT a blob error: it propagates untouched so a worker retries instead of dropping the family", async () => {
    const sealed = await healthy.encrypt(
      ORG,
      "bereaved_contact.mailing_address",
      "10 Sample Street",
    );
    const down = createBereavementCipher({
      dekForOrg: async () => {
        throw new Error("key ring unavailable");
      },
      dekForOrgVersion: async () => {
        throw new Error("key ring unavailable");
      },
    });
    const outcome = await down.decrypt(ORG, "bereaved_contact.mailing_address", sealed).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(BereavementCipherBlobError);
    expect((outcome as Error).message).toBe("key ring unavailable");
  });
});

describe("the generate job id", () => {
  it("carries no colon (BullMQ's custom-id rules) and differs per run, version and re-send epoch", () => {
    const a = mailingGenerateJobId({ organizationId: ORG, runId: ID, version: 2 });
    expect(a).not.toContain(":");
    expect(mailingGenerateJobId({ organizationId: ORG, runId: ID, version: 3 })).not.toBe(a);
    expect(
      mailingGenerateJobId({ organizationId: ORG, runId: ID, version: 2, resendEpoch: 7 }),
    ).not.toBe(a);
    expect(
      mailingGenerateJobId({ organizationId: ORG, runId: ID, version: 2, resendEpoch: 7 }),
    ).not.toBe(
      mailingGenerateJobId({ organizationId: ORG, runId: ID, version: 2, resendEpoch: 8 }),
    );
    // the same request twice is the same job (the enqueue is idempotent)
    expect(mailingGenerateJobId({ organizationId: ORG, runId: ID, version: 2 })).toBe(a);
  });
});

describe("addressLinesOf", () => {
  it("splits on newlines, trims, drops blanks and keeps at most eight lines", () => {
    expect(addressLinesOf("  10 Sample Street \r\n\n Testville, ZZ 00000  ")).toEqual([
      "10 Sample Street",
      "Testville, ZZ 00000",
    ]);
    expect(addressLinesOf("one-line address, Testville")).toEqual(["one-line address, Testville"]);
    expect(addressLinesOf("   \n  ")).toEqual([]);
    expect(
      addressLinesOf(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")),
    ).toHaveLength(8);
  });
});

describe("the mailing config body", () => {
  it("refuses an empty audience list (it would mail nobody); null still means every relationship", () => {
    const body = { enabled: true, leadDays: 10, content: {} };
    expect(() => parse(PutMailingConfigBody, { ...body, audienceRelationships: [] })).toThrow(
      ValidationError,
    );
    expect(parse(PutMailingConfigBody, { ...body, audienceRelationships: null })).toMatchObject({
      audienceRelationships: null,
    });
    expect(
      parse(PutMailingConfigBody, { ...body, audienceRelationships: ["spouse"] }),
    ).toMatchObject({ audienceRelationships: ["spouse"] });
  });
});
