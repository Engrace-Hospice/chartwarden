// C4 - a signed amending addendum leaves a real audit event (ADR-0114 VN-D30, CW-AC-51): ONE per addendum, in the addendum's sign transaction, with
// the addendum id and how many sections it amended and nothing else. `audit.read` is not Part 2 gated, so an event that named a section, or said
// whether it was Part 2, would tell an audit reader which sections hold Part 2: the per-section trail is the row trigger of the sealed amendment
// row (actor and scrubbed image), not this event. Mocks the audit writer; the live suite proves the row lands.
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

const eventOf = (call: unknown[]) =>
  call[2] as {
    eventType: string;
    resourceKind: string;
    resourceId: string;
    outcome: string;
    severity: string;
    retentionClass?: string;
    after: Record<string, unknown>;
  };

beforeEach(() => auditMock.mockClear());

describe("recordSectionsAmended", () => {
  it("writes ONE event per addendum, however many sections it amended, against the encounter, on the sign transaction and the request's context", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sectionCount: 3,
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]).toEqual([
      TX,
      CONTEXT,
      expect.objectContaining({
        eventType: "m8.encounter.section_amended",
        resourceKind: "encounter",
        resourceId: ENCOUNTER,
        outcome: "success",
        severity: "info",
        after: { addendumId: ADDENDUM, sectionCount: 3 },
      }),
    ]);
  });

  it("records the addendum id and the count only: no section id, no Part 2 flag, no text, no hash, no source id", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sectionCount: 1,
    });
    const event = eventOf(auditMock.mock.calls[0] as unknown[]);
    expect(Object.keys(event.after).sort()).toEqual(["addendumId", "sectionCount"]);
    expect(JSON.stringify(event)).not.toMatch(/part2|sectionId/i);
  });

  it("files under the standard retention class: never the Part 2 class, which would itself mark the addendum as one that amended Part 2 content", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sectionCount: 2,
    });
    expect(eventOf(auditMock.mock.calls[0] as unknown[]).retentionClass).toBe("compliance");
  });

  it("writes nothing for an addendum that amended no section", async () => {
    await recordSectionsAmended(TX, CONTEXT, {
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sectionCount: 0,
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("is catalogued as NOT Part 2 eligible, so the audit helper refuses the Part 2 class for it and the catalog and the helper agree on its name", () => {
    const entry = M8_ACTION_CATALOG.find((e) => e.action === SECTION_AMENDED_AUDIT_EVENT);
    expect(entry).toMatchObject({ defaultRetentionClass: "compliance", isPartTwoEligible: false });
  });
});
