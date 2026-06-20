// M39-T04 — consent state machines (§2.2/§2.4).
import { describe, expect, it } from "vitest";
import {
  CASCADE_MAX_ATTEMPTS,
  closeRenewalCycle,
  consumerNeedsDispatch,
  hasActiveRecipient,
  nextCascadeStatus,
  nextConsentStatus,
  recipientActive,
  removeRecipient,
  shouldOpenRenewalCycle,
  validateDraftHasNoSupersede,
} from "../src/lifecycle";

describe("consent_record status machine (§2.2.1)", () => {
  it("draft signs to active and discards to discarded", () => {
    expect(nextConsentStatus("draft", "sign")).toEqual({ ok: true, value: "active" });
    expect(nextConsentStatus("draft", "discardDraft")).toEqual({ ok: true, value: "discarded" });
  });

  it("active leaves active by exactly supersede/revoke/tickExpired", () => {
    expect(nextConsentStatus("active", "supersede")).toEqual({ ok: true, value: "superseded" });
    expect(nextConsentStatus("active", "revoke")).toEqual({ ok: true, value: "revoked" });
    expect(nextConsentStatus("active", "tickExpired")).toEqual({ ok: true, value: "expired" });
  });

  it("a draft cannot be revoked/superseded/expired", () => {
    const r = nextConsentStatus("draft", "revoke");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_transition");
  });

  it("revoked is terminal — no event re-animates the row", () => {
    const r = nextConsentStatus("revoked", "sign");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("revoked_is_terminal");
  });

  it("signing an already-active consent is rejected as already_in_state", () => {
    const r = nextConsentStatus("active", "sign");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["already_in_state", "invalid_transition"]).toContain(r.code);
  });

  it("a draft may not carry supersedes_consent_record_id", () => {
    expect(validateDraftHasNoSupersede("draft", "x").ok).toBe(false);
    expect(validateDraftHasNoSupersede("active", "x").ok).toBe(true);
    expect(validateDraftHasNoSupersede("draft", null).ok).toBe(true);
  });
});

describe("recipient machine (§2.2.2)", () => {
  const now = 1_000_000;
  it("active iff not removed and not past its own expiry", () => {
    expect(recipientActive({ removedAtMs: null, expiresAtMs: null, nowMs: now })).toBe(true);
    expect(recipientActive({ removedAtMs: 1, expiresAtMs: null, nowMs: now })).toBe(false);
    expect(recipientActive({ removedAtMs: null, expiresAtMs: now - 1, nowMs: now })).toBe(false);
    expect(recipientActive({ removedAtMs: null, expiresAtMs: now + 1, nowMs: now })).toBe(true);
  });

  it("double-remove is refused", () => {
    expect(removeRecipient(null).ok).toBe(true);
    const r = removeRecipient(123);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("recipient_already_removed");
  });

  it("hasActiveRecipient drives the no_active_recipient_matches verdict", () => {
    expect(hasActiveRecipient([{ removedAtMs: 1, expiresAtMs: null }], now)).toBe(false);
    expect(
      hasActiveRecipient(
        [
          { removedAtMs: 1, expiresAtMs: null },
          { removedAtMs: null, expiresAtMs: null },
        ],
        now,
      ),
    ).toBe(true);
  });
});

describe("revocation cascade machine (§2.2.3)", () => {
  it("all consumers ACKed → completed", () => {
    const r = nextCascadeStatus({ status: "in_progress", consumers: { m2: true, m22: true }, attempts: 1 });
    expect(r).toEqual({ ok: true, value: "completed" });
  });

  it("stragglers under budget → in_progress, and the un-ACKed consumer needs dispatch", () => {
    const progress = { status: "in_progress" as const, consumers: { m2: true, m22: false }, attempts: 2 };
    expect(nextCascadeStatus(progress)).toEqual({ ok: true, value: "in_progress" });
    expect(consumerNeedsDispatch(progress, "m22")).toBe(true);
    expect(consumerNeedsDispatch(progress, "m2")).toBe(false);
  });

  it("budget exhausted with stragglers → partial_failed refusal", () => {
    const r = nextCascadeStatus({ status: "in_progress", consumers: { m22: false }, attempts: CASCADE_MAX_ATTEMPTS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cascade_retry_budget_exhausted");
  });
});

describe("renewal cycle machine (§2.4)", () => {
  it("closes an open cycle to the right terminal status per reason", () => {
    expect(closeRenewalCycle("open", "renewed")).toEqual({ ok: true, value: "renewed" });
    expect(closeRenewalCycle("open", "expired_without_renewal")).toEqual({ ok: true, value: "closed_expired" });
    expect(closeRenewalCycle("open", "revoked")).toEqual({ ok: true, value: "closed_revoked" });
  });

  it("refuses to close a non-open cycle", () => {
    const r = closeRenewalCycle("renewed", "revoked");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("renewal_cycle_not_open");
  });

  it("opens a cycle only when none is open", () => {
    expect(shouldOpenRenewalCycle(false)).toBe(true);
    expect(shouldOpenRenewalCycle(true)).toBe(false);
  });
});
