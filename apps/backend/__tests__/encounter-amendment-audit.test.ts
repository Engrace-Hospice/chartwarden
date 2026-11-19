// C4 - an amended section leaves a real audit event (ADR-0114 VN-D30, CW-AC-51): one per section, in the addendum's sign transaction, with the
// retention class chosen by the section's Part 2 flag and ids and the flag only. Mocks the audit writer; the live suite proves the row lands.
import { M8_ACTION_CATALOG } from "@chartwarden/audit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@chartwarden/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chartwarden/audit")>()),
  audit: auditMock,
}));

import type { AuditContext } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import {
  SECTION_AMENDED_AUDIT_EVENT,
  recordSectionsAmended,
} from "../src/modules/08-encounters/drafting/amendment-audit";

const TX = {} as DbClient;
const CONTEXT: AuditContext = { organizationId: "org", userId: "user", correlationId: "corr" };
const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const ADDENDUM = "00000000-0000-4000-8000-0000000000ad";

beforeEach(() => auditMock.mockClear());

describe("recordSectionsAmended", () => {
  it("writes one event per amended section, against the encounter, on the sign transaction and the request's context", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sections: [
        { sectionId: "plan", part2Derived: false },
        { sectionId: "interventions", part2Derived: false },
      ],
    });
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock.mock.calls[0]).toEqual([
      TX,
      CONTEXT,
      expect.objectContaining({
        eventType: "m8.encounter.section_amended",
        resourceKind: "encounter",
        resourceId: ENCOUNTER,
        outcome: "success",
        severity: "info",
        retentionClass: "compliance",
        after: { addendumId: ADDENDUM, sectionId: "plan", part2Derived: false },
      }),
    ]);
  });

  it("files a Part 2 derived section under the Part 2 retention class and any other under compliance, section by section", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sections: [
        { sectionId: "plan", part2Derived: true },
        { sectionId: "interventions", part2Derived: false },
      ],
    });
    const classes = auditMock.mock.calls.map(
      (call) =>
        (call as unknown as [unknown, unknown, { retentionClass: string }])[2].retentionClass,
    );
    expect(classes).toEqual(["compliance_42cfr_part2", "compliance"]);
  });

  it("records ids and a flag only: no text, no hash, no source id", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sections: [{ sectionId: "plan", part2Derived: true }],
    });
    const event = (auditMock.mock.calls[0] as unknown as [unknown, unknown, { after: object }])[2];
    expect(Object.keys(event.after).sort()).toEqual(["addendumId", "part2Derived", "sectionId"]);
  });

  it("writes nothing for an addendum that amended no section", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sections: [],
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("is catalogued as Part 2 eligible, so the audit helper and the catalog agree on its name and class", () => {
    const entry = M8_ACTION_CATALOG.find((e) => e.action === SECTION_AMENDED_AUDIT_EVENT);
    expect(entry).toMatchObject({ defaultRetentionClass: "compliance", isPartTwoEligible: true });
  });
});
