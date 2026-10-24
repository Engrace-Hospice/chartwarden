// WP 5.6 security review: `criteria.origin = "messaging_governance"` marks holds placed through M36's governance apply route. It is
// provenance, NOT a selector: every criteria reader must ignore it, and the governance seam must see only marked holds.
import {
  MESSAGING_GOVERNANCE_ORIGIN_MARKER,
  holdCoversGroup,
  isMessagingOnlyCriteria,
} from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import { messageHeldBy } from "@chartwarden/messaging";
import { MESSAGING_GOVERNANCE_HOLD_ORIGIN } from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { legalHoldScopeOf } from "../src/modules/04-audit/legal-hold-scope";
import {
  createMessagingGovernanceHoldPort,
  getLegalHold,
  hasSelector,
  isGovernanceHold,
} from "../src/modules/04-audit/messaging-hold-workflow";
import { LegalHoldCriteriaSchema } from "../src/modules/04-audit/routes/audit-typebox";
import { holdCoversDataClass } from "../src/modules/04-audit/routes/destruction-certificates";
import { holdPredicate } from "../src/modules/36-messaging/jobs/retention-hold-sql";

const ORG = "11111111-1111-4111-8111-111111111111";
const CH = "44444444-4444-4444-8444-444444444444";
const ID = "55555555-5555-4555-8555-555555555555";
const MARK = { origin: MESSAGING_GOVERNANCE_HOLD_ORIGIN };
const facts = {
  createdAt: "2026-03-05T00:00:00Z",
  authorUserId: null,
  channelId: CH,
  channelKind: "dm",
  channelSubjectId: null,
  referencedPatientIds: [],
  memberUserIds: [],
};
const group = {
  retentionClass: "compliance",
  resourceKind: "message",
  resourceId: ID,
  organizationId: ORG,
  destructionCertificateId: "c",
} as never;

describe("origin marker is provenance, not a selector", () => {
  it("is accepted by the criteria schema", () => {
    expect(Value.Check(LegalHoldCriteriaSchema, { channelIds: [CH], ...MARK })).toBe(true);
  });
  it("hasSelector: a marker-only criteria still has no selector; a marker never hides a real one", () => {
    expect(hasSelector(MARK)).toBe(false);
    expect(hasSelector({ channelIds: [CH], ...MARK })).toBe(true);
  });
  it("the audit package's marker equals the types constant", () => {
    expect(MESSAGING_GOVERNANCE_ORIGIN_MARKER).toBe(MESSAGING_GOVERNANCE_HOLD_ORIGIN);
  });
  it("isMessagingOnlyCriteria: a marked hold without patients protects messages only; patientIds keep it patient-scoped", () => {
    expect(isMessagingOnlyCriteria({ channelIds: [CH], ...MARK })).toBe(true);
    expect(isMessagingOnlyCriteria({ resourceKinds: ["message"], ...MARK })).toBe(true);
    expect(isMessagingOnlyCriteria({ resourceKinds: ["message"] })).toBe(false);
    expect(isMessagingOnlyCriteria({ patientIds: [ID], ...MARK })).toBe(false);
    expect(isMessagingOnlyCriteria({ patientIds: [ID], channelIds: [CH], ...MARK })).toBe(false);
  });
  it("holdCoversGroup: an org-wide governance hold covers no audit group; a patient-scoped one still does", () => {
    expect(holdCoversGroup(MARK, group)).toBe(false);
    expect(holdCoversGroup({ resourceKinds: ["message"], ...MARK }, group)).toBe(false);
    expect(holdCoversGroup({ channelIds: [CH], ...MARK }, group)).toBe(false);
    expect(holdCoversGroup({ patientIds: [ID], ...MARK }, group)).toBe(true);
  });
  it("holdCoversDataClass: message classes still held, audit classes not, by an org-wide governance hold", () => {
    const range = { start: new Date(0), end: new Date() };
    const org = { resourceKinds: ["message"], ...MARK };
    expect(holdCoversDataClass(org, "message.operational", range)).toBe(true);
    expect(holdCoversDataClass(org, "audit_event.compliance", range)).toBe(false);
    expect(holdCoversDataClass({ resourceKinds: ["message"] }, "message.operational", range)).toBe(
      true,
    );
  });
  it("legalHoldScopeOf: an org-wide governance hold is messagingHeld, never orgWide; a patient one scopes to the patient", () => {
    expect(legalHoldScopeOf([{ channelIds: [CH], ...MARK }])).toEqual(
      legalHoldScopeOf([{ channelIds: [CH] }]),
    );
    expect(legalHoldScopeOf([{ patientIds: [ID], ...MARK }]).patientIds.has(ID)).toBe(true);
    const org = legalHoldScopeOf([{ resourceKinds: ["message"], ...MARK }]);
    expect(org.orgWide).toBe(false);
    expect(org.messagingHeld).toBe(true);
    expect(legalHoldScopeOf([{ resourceKinds: ["message"] }]).orgWide).toBe(true);
  });
  it("messageHeldBy: marker neither widens a channel hold nor narrows an org-wide one", () => {
    expect(messageHeldBy({ channelIds: [CH], ...MARK }, facts)).toBe(true);
    expect(messageHeldBy({ channelIds: [ID], ...MARK }, facts)).toBe(false);
    expect(messageHeldBy({ resourceKinds: ["message"], ...MARK }, facts)).toBe(true);
  });
  it("holdPredicate (SQL mirror) renders identically with and without the marker", () => {
    const render = (c: object) => JSON.stringify(holdPredicate(c as never).queryChunks);
    expect(render({ channelIds: [CH], ...MARK })).toBe(render({ channelIds: [CH] }));
    expect(render({ resourceKinds: ["message"], ...MARK })).toBe(
      render({ resourceKinds: ["message"] }),
    );
  });
});

describe("governance port only sees marked holds", () => {
  const row = (criteria: unknown) => ({
    id: ID,
    organizationId: ORG,
    name: "n",
    criteria,
    status: "active",
    reason: "r",
    appliedBy: null,
    appliedAt: new Date(),
    releasedAt: null,
  });
  const txReturning = (r: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "from", "where"]) chain[m] = () => chain;
    chain.limit = () => Promise.resolve(r);
    return chain as unknown as DbClient;
  };
  it("isGovernanceHold keys on the exact marker", () => {
    expect(isGovernanceHold(MARK)).toBe(true);
    expect(isGovernanceHold({ origin: "other" })).toBe(false);
    expect(isGovernanceHold({ channelIds: [CH] })).toBe(false);
    expect(isGovernanceHold(null)).toBe(false);
  });
  it("get returns a marked hold and null for an M4-placed one (same answer as unknown)", async () => {
    expect(
      (await getLegalHold(txReturning([row({ channelIds: [CH], ...MARK })]), ORG, ID))?.id,
    ).toBe(ID);
    expect(await getLegalHold(txReturning([row({ channelIds: [CH] })]), ORG, ID)).toBeNull();
    expect(await getLegalHold(txReturning([row({ patientIds: [ID] })]), ORG, ID)).toBeNull();
    expect(await getLegalHold(txReturning([]), ORG, ID)).toBeNull();
  });
  it("port.release 404s on an M4-placed hold before touching it", async () => {
    const port = createMessagingGovernanceHoldPort({});
    await expect(
      port.release(txReturning([row({ patientIds: [ID] })]), {} as never, {
        organizationId: ORG,
        holdId: ID,
        reason: "long enough reason",
        countRestored: async () => 0,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
