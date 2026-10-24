// WP 5.6 (ADR-0086, PROPOSED) - the destruction executor's pure rules, with no database: the mode switch (tenant flag, then the deployment key)
// and the ONE shared "destroyable" predicate (planning, the delete and the dry run all use it, so it must always carry the hold exclusion).
// The behaviour against Postgres is proved in m36-retention-destruction.live.test.ts; the weekly tick wiring in m36-retention-destruction.test.ts.
import { RETENTION_DESTRUCTION_MODES, retentionDestructionModeOf } from "@chartwarden/types";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  DESTRUCTION_BATCH_SIZE,
  DESTRUCTION_MAX_BATCHES_PER_CERTIFICATE,
  destroyablePredicate,
} from "../src/modules/36-messaging/jobs/retention-destruction";

const ORG = "11111111-1111-4111-8111-111111111111";
const HOLD = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";

describe("retentionDestructionModeOf", () => {
  it("is off without the flag, whatever the deployment key says", () => {
    expect(retentionDestructionModeOf(false, false)).toBe("off");
    expect(retentionDestructionModeOf(false, true)).toBe("off");
  });
  it("is a dry run with the flag alone, and live only with both keys", () => {
    expect(retentionDestructionModeOf(true, false)).toBe("dry_run");
    expect(retentionDestructionModeOf(true, true)).toBe("live");
  });
  it("only ever yields the three declared modes", () => {
    for (const flag of [true, false])
      for (const exec of [true, false])
        expect(RETENTION_DESTRUCTION_MODES).toContain(retentionDestructionModeOf(flag, exec));
  });
});

describe("destroyablePredicate", () => {
  const render = (holds: Parameters<typeof destroyablePredicate>[3]) =>
    new PgDialect().sqlToQuery(
      destroyablePredicate(ORG, "care_related", new Date("2019-01-01T00:00:00Z"), holds),
    );

  it("with no active hold still excludes object-bearing and referenced messages, and bounds by class, window and org", () => {
    const q = render([]);
    expect(q.sql).toContain("c.retention_class =");
    expect(q.sql).toContain("m.created_at <");
    expect(q.sql).toContain("m.organization_id =");
    expect(q.sql).toContain("message_attachment");
    expect(q.sql).toContain("object_destroyed_at IS NULL");
    expect(q.sql).toContain("parent_message_id");
    expect(q.sql).toContain("quoted_message_id");
    expect(q.params).toContain("care_related");
    expect(q.params).toContain(ORG);
  });

  it("with an active hold excludes BOTH the materialised overlay and the live criteria", () => {
    const q = render([{ id: HOLD, criteria: { channelIds: [CHANNEL] } }]);
    expect(q.sql).toContain("legal_hold_message");
    expect(q.sql).toContain("m.channel_id IN");
    // NOT (overlay OR live criteria): one negation over the pair, so neither half can be skipped.
    expect(q.sql).toMatch(/NOT \(EXISTS[\s\S]*\) OR \(\(m\.channel_id IN/);
    expect(q.params).toContain(HOLD);
    expect(q.params).toContain(CHANNEL);
  });

  it("is bounded: a batch and a per-run budget are named constants", () => {
    expect(DESTRUCTION_BATCH_SIZE).toBeLessThanOrEqual(1000);
    expect(DESTRUCTION_MAX_BATCHES_PER_CERTIFICATE).toBeGreaterThan(0);
  });
});

describe("objectBearingMessagesCountable (scan counts objects only when the executor will destroy them)", () => {
  const all = { destructionEnabled: true, attachmentDestructionEnabled: true, executorWired: true };
  it("is true only with both flags on and the executor wired", async () => {
    const { objectBearingMessagesCountable } = await import(
      "../src/modules/36-messaging/jobs/retention-scan"
    );
    expect(objectBearingMessagesCountable(all)).toBe(true);
    expect(objectBearingMessagesCountable({ ...all, destructionEnabled: false })).toBe(false);
    expect(objectBearingMessagesCountable({ ...all, attachmentDestructionEnabled: false })).toBe(false);
    expect(objectBearingMessagesCountable({ ...all, executorWired: false })).toBe(false);
  });
});
