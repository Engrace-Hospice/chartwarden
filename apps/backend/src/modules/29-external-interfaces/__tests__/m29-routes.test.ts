// apps/backend/src/modules/29-external-interfaces/__tests__/m29-routes.test.ts — M29-T08 §4.1/§4.2 store rules.
//
// Exercises the in-memory M29Store the route handlers compose over — the FSM + propose-then-review + rejection
// rules the Drizzle store shares from the same T03/T04 cores, so a passing test here tests the RULE, not a
// second spelling of it.
import { ConflictError, NotFoundError, ValidationError } from "@wardenx/types";
import { describe, expect, it } from "vitest";

import { createInMemoryM29Store } from "../routes/store";

const ORG = "org-1";
const OTHER = "org-2";
const OP = "membership-operator";
const COMPLIANCE = "membership-compliance";

const freshStore = () => createInMemoryM29Store({ now: () => "2026-08-02T00:00:00.000Z" });

describe("feed onboarding FSM (§2.2)", () => {
  it("creates a feed in pending_approval stamping the proposing operator", async () => {
    const store = freshStore();
    const feed = await store.createFeed(ORG, OP, {
      kind: "adt_inbound",
      displayName: "Mercy ADT",
      port: 6000,
      protocol: "mllp_tls",
    });
    expect(feed.status).toBe("pending_approval");
    expect(feed.proposedByMembershipId).toBe(OP);
    expect(feed.approvedByOpId).toBe(OP);
    expect(feed.approvedByComplId).toBeNull();
  });

  it("activates only with a compliance co-approver DISTINCT from the operator (D18)", async () => {
    const store = freshStore();
    const feed = await store.createFeed(ORG, OP, {
      kind: "adt_inbound",
      displayName: "Mercy ADT",
      port: 6000,
      protocol: "mllp_tls",
    });
    // self-approval is refused
    await expect(store.activateFeed(ORG, OP, feed.id)).rejects.toBeInstanceOf(ConflictError);
    // a distinct compliance officer activates
    const active = await store.activateFeed(ORG, COMPLIANCE, feed.id);
    expect(active.status).toBe("active");
    expect(active.approvedByComplId).toBe(COMPLIANCE);
    expect(active.activeFrom).not.toBeNull();
  });

  it("walks suspend → re-activate → revoke and refuses edits after revoke", async () => {
    const store = freshStore();
    const feed = await store.createFeed(ORG, OP, {
      kind: "lab_inbound",
      displayName: "Quest",
      port: 6100,
      protocol: "mllp_tls",
    });
    await store.activateFeed(ORG, COMPLIANCE, feed.id);
    const suspended = await store.suspendFeed(ORG, OP, feed.id, "cert-pin storm");
    expect(suspended.status).toBe("suspended");
    const reactivated = await store.activateFeed(ORG, OP, feed.id);
    expect(reactivated.status).toBe("active");
    const revoked = await store.revokeFeed(ORG, OP, feed.id, { reason: "partner offboarded" });
    expect(revoked.status).toBe("revoked");
    await expect(
      store.updateFeed(ORG, OP, feed.id, { displayName: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
    // revoke is terminal
    await expect(store.revokeFeed(ORG, OP, feed.id, { reason: "again" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("scopes reads to the acting org (cross-tenant is a 404)", async () => {
    const store = freshStore();
    const feed = await store.createFeed(ORG, OP, {
      kind: "adt_inbound",
      displayName: "Mercy",
      port: 6000,
      protocol: "mllp_tls",
    });
    expect(await store.getFeed(OTHER, feed.id)).toBeNull();
    await expect(store.updateFeed(OTHER, OP, feed.id, {})).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("credential rotation (§4.1.1)", () => {
  it("mints an active credential and retires the prior active of the same kind, never returning ciphertext", async () => {
    const store = freshStore();
    const feed = await store.createFeed(ORG, OP, {
      kind: "adt_inbound",
      displayName: "Mercy",
      port: 6000,
      protocol: "mllp_tls",
    });
    const first = await store.mintCredential(ORG, OP, feed.id, {
      kind: "mllp_channel_password",
      secret: "s3cr3t-one",
    });
    expect(first.status).toBe("active");
    expect(first).not.toHaveProperty("secret");
    expect(first).not.toHaveProperty("secretCipher");
    await store.mintCredential(ORG, OP, feed.id, {
      kind: "mllp_channel_password",
      secret: "s3cr3t-two",
    });
    const creds = await store.listCredentials(ORG, feed.id);
    expect(creds.filter((c) => c.status === "active")).toHaveLength(1);
    expect(creds.filter((c) => c.status === "retired")).toHaveLength(1);
  });
});

describe("propose-then-review adjudication (§4.1.2 / D5)", () => {
  it("accepts a pending proposal and then refuses re-decision (decided-is-decided)", async () => {
    const store = freshStore();
    store.seedProposal(ORG, { id: "p1", proposalStatus: "pending", ownerModule: "m5" });
    const accepted = await store.acceptProposal(ORG, COMPLIANCE, "p1", {
      decisionNote: "verified against source",
      acceptedAggregateId: "patient-9",
    });
    expect(accepted.proposalStatus).toBe("accepted");
    expect(accepted.decidedByMembershipId).toBe(COMPLIANCE);
    expect(accepted.acceptedAggregateId).toBe("patient-9");
    await expect(
      store.acceptProposal(ORG, COMPLIANCE, "p1", {}),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a pending proposal with a ≥40-char rationale and enforces the floor", async () => {
    const store = freshStore();
    store.seedProposal(ORG, { id: "p2", proposalStatus: "pending" });
    await expect(store.rejectProposal(ORG, COMPLIANCE, "p2", "too short")).rejects.toBeInstanceOf(
      ValidationError,
    );
    const rationale = "Duplicate ADT for a patient already discharged — no chart action warranted.";
    const rejected = await store.rejectProposal(ORG, COMPLIANCE, "p2", rationale);
    expect(rejected.proposalStatus).toBe("rejected");
    expect(rejected.decisionRationale).toBe(rationale);
  });

  it("defers a pending proposal, leaving it pending", async () => {
    const store = freshStore();
    store.seedProposal(ORG, { id: "p3", proposalStatus: "pending" });
    const deferred = await store.deferProposal(ORG, COMPLIANCE, "p3");
    expect(deferred.proposalStatus).toBe("pending");
  });

  it("404s a cross-tenant proposal", async () => {
    const store = freshStore();
    store.seedProposal(ORG, { id: "p4", proposalStatus: "pending" });
    await expect(store.acceptProposal(OTHER, COMPLIANCE, "p4", {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("clinician lab reads (§4.2)", () => {
  it("lists + reads observations scoped to the acting org", async () => {
    const store = freshStore();
    store.seedObservation(ORG, {
      id: "o1",
      patientId: "pat-1",
      loincCode: "2345-7",
      abnormalSummary: "any_critical",
      values: [{ obxSetId: 1, loincCode: "2345-7", loincDisplayText: "Glucose", valueType: "NM", numericValue: 410, stringValue: null, units: "mg/dL", referenceRange: "70-110", abnormalFlag: "HH" }],
    });
    const page = await store.listObservations(ORG, {});
    expect(page.items).toHaveLength(1);
    expect(await store.listObservations(OTHER, {})).toEqual({ items: [] });
    const detail = await store.getObservation(ORG, "o1");
    expect(detail?.values).toHaveLength(1);
    expect(await store.getObservation(OTHER, "o1")).toBeNull();
  });
});
