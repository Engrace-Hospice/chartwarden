// GAP-052 - PortalDisclosureAccountingProvider returns the patient's portal-accessor disclosure lines
// (it used to return [] unconditionally).
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { type PortalDisclosureSource, buildDrizzlePortalStore } from "../routes/store";

const ORG = "33333333-3333-4333-8333-333333333333";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const DOCUMENT = "44444444-4444-4444-8444-444444444444";
const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-12-31T00:00:00.000Z";

const db = {} as unknown as DbClient;

describe("PortalDisclosureAccountingProvider", () => {
  it("maps portal-accessor access-log rows into section 164.528 lines", async () => {
    const calls: unknown[][] = [];
    const source: PortalDisclosureSource = async (...args) => {
      calls.push(args);
      return [
        {
          portalAccountId: ACCOUNT,
          patientId: PATIENT,
          documentId: DOCUMENT,
          accessedAt: new Date("2026-06-01T12:00:00.000Z"),
        },
      ];
    };
    const store = buildDrizzlePortalStore(db, undefined, source);

    const lines = await store.disclosures.disclosuresForPatient(
      ORG as never,
      PATIENT as never,
      FROM as never,
      TO as never,
    );

    expect(lines).toEqual([
      {
        portalAccountId: ACCOUNT,
        patientId: PATIENT,
        routePath: `/portal/documents/${DOCUMENT}`,
        dataCategoriesDisclosed: ["documents"],
        viewedAt: "2026-06-01T12:00:00.000Z",
      },
    ]);
    expect(calls[0]).toEqual([ORG, PATIENT, new Date(FROM), new Date(TO)]);
  });

  it("reports no lines (never throws) when no source is bound", async () => {
    const store = buildDrizzlePortalStore(db);
    const lines = await store.disclosures.disclosuresForPatient(
      ORG as never,
      PATIENT as never,
      FROM as never,
      TO as never,
    );
    expect(lines).toEqual([]);
  });
});
