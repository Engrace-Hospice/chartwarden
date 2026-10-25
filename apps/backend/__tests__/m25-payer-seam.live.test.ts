/**
 * M25 payer seam - LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role, through the REAL M40 `createDbMdmStore`.
 *
 * The M25 payer-appeal suites inject a fake `PayerSeam`, which let `buildSeamPayerSeam` read `canonical.name` while the real
 * M40 payload carries `canonical.displayName` (and no `kind`), so no payer ever resolved. This suite runs the seam end to end
 * against the registered provider: it resolves the name and kind of a payer of every kind, and fails closed to null for an
 * unknown id. (The payer registry is GLOBAL, org-less, so there is no "another tenant's payer"; an org id never narrows it.)
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:payer-seam:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSeamPayerSeam } from "../src/modules/25-remittance/routes/payer-seam";
import { createDbMdmStore, registerMdmSeams } from "../src/modules/40-mdm/index";
import { type M7Fixture, ORG, ORG_B, setupM7Fixture } from "./_m25-m7-fixture";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const KINDS = ["medicare_advantage", "commercial", "medicaid", "other"] as const;

describe.skipIf(!DB_URL)("M25 payer seam through the real M40 store - LIVE Postgres", () => {
  let fx: M7Fixture;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-ps");
    registerMdmSeams({ store: createDbMdmStore(fx.handle.db) });
    for (const kind of KINDS) {
      const id = randomUUID();
      ids.set(kind, id);
      await fx.admin.query(
        "INSERT INTO payer (id, kind, name, status) VALUES ($1, $2::payer_kind, $3, 'active')",
        [id, kind, `Seam ${kind}`],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
  });

  it.each(KINDS)("resolves the name and kind of a %s payer", async (kind) => {
    const id = ids.get(kind) as string;
    const resolved = await buildSeamPayerSeam().resolve(ORG, id);
    expect(resolved).toEqual({ id, name: `Seam ${kind}`, kind });
  });

  it("resolves the same global payer for another tenant", async () => {
    const id = ids.get("commercial") as string;
    expect(await buildSeamPayerSeam().resolve(ORG_B, id)).toMatchObject({ kind: "commercial" });
  });

  it("returns null for an unknown payer", async () => {
    expect(await buildSeamPayerSeam().resolve(ORG, randomUUID())).toBeNull();
  });
});
