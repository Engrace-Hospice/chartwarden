// apps/backend/src/modules/06-admission/state-machines/commands.ts — M6-T04 (§2.3.6, §2.4).
//
// Revocation / Transfer / Discharge are one-shot records with no internal multi-step lifecycle — the
// important part is the SIDE-EFFECT CASCADE they trigger (§2.3.6). They are modelled as "command +
// cascade": each validates its §2.4 rule set then returns the ordered side-effect list (close the
// election period, end the LCP, the `m6.*` outbox fan-out) the service runs in one transaction. The
// admission-status flip itself is driven by `transitionAdmission(executeDischarge)` (§2.3.1) — these
// commands describe the period/LCP/outbox cascade that rides the same transaction.
import type { LocalDate } from "@wardenx/types";
import type { SideEffect } from "./effects";
import { checkDeathCertifier, daysBetween } from "./validation";
import { require_ } from "./errors";

/** A command's resolved cascade (the §2.5 in-transaction side-effect list). */
export interface CommandCascade {
  readonly effects: ReadonlyArray<SideEffect>;
}

/**
 * Revocation (§2.3.6): validates the election period is active and the effective date is not before
 * the signed date (R-RV-01), then closes the period (cause=revocation), ends the LCP, and fans out
 * `m6.revocation.created`. The admission moves to `discharged` (revocation is a kind of discharge per
 * CoP 418.28) via `transitionAdmission`.
 */
export function planRevocation(input: {
  electionPeriodActive: boolean;
  signedAt: LocalDate;
  effectiveAt: LocalDate;
}): CommandCascade {
  require_(input.electionPeriodActive, "ILLEGAL_TRANSITION", "no active election period to revoke");
  require_(
    daysBetween(input.signedAt, input.effectiveAt) >= 0,
    "REVOCATION_EFFECTIVE_BEFORE_SIGNED",
    "revocation effective date precedes the signed date",
  );
  return {
    effects: [
      { kind: "end_election_period", cause: "revocation" },
      { kind: "end_level_of_care" },
      { kind: "audit" },
      { kind: "outbox", event: "m6.revocation.created" },
    ],
  };
}

/**
 * Transfer-out (§2.3.6): only one transfer per benefit period (R-XFR-01). Closes the period
 * (cause=transfer), ends the LCP, fans out `m6.transfer.created` carrying the period sequence so the
 * receiving hospice can inherit it. The admission moves to `discharged`.
 */
export function planTransferOut(input: { transferAlreadyDoneThisPeriod: boolean }): CommandCascade {
  require_(!input.transferAlreadyDoneThisPeriod, "TRANSFER_LIMIT_EXCEEDED", "only one transfer per benefit period");
  return {
    effects: [
      { kind: "end_election_period", cause: "transfer" },
      { kind: "end_level_of_care" },
      { kind: "audit" },
      { kind: "outbox", event: "m6.transfer.created" },
    ],
  };
}

/**
 * Transfer-in (§2.3.6): validates the source CCN (NPPES via M40) and the carried period sequence
 * (R-XFR-02). The caller creates a NEW admission with `transferred_in=true`; no re-collection of the
 * election statement is required if the prior signed statement is in hand and re-acknowledged.
 */
export function validateTransferIn(input: { sourceCcnValid: boolean; carriedSequencePresent: boolean }): void {
  require_(
    input.sourceCcnValid && input.carriedSequencePresent,
    "TRANSFER_IN_SOURCE_INVALID",
    "transfer-in requires a valid source CCN and the carried period sequence",
  );
}

/**
 * Discharge (§2.3.6): the `discharge_type` discriminator controls the cascade. `death` →
 * `bereavement` + `m6.bereavement.eligible`; everything else → `discharged`. In all cases the LCP and
 * election period end and `discharge.executed` fans out (here `m6.discharge.death|created`). The
 * `for_cause` path needs DON + Medical Director co-sign (R-ADM-03); `death` needs a credentialed
 * certifier (R-DC-01). One discharge per admission is the table UNIQUE; the service surfaces it.
 */
export function planDischarge(input: {
  dischargeType: "death" | "routine" | "for_cause" | "moved" | "no_longer_terminal" | "revocation" | "transfer";
  forCauseCosigned: boolean;
  deathAt?: LocalDate;
  today?: LocalDate;
  deathCertifierCredentialed?: boolean;
}): CommandCascade {
  if (input.dischargeType === "for_cause") {
    require_(input.forCauseCosigned, "FOR_CAUSE_REQUIRES_COSIGN", "for-cause discharge requires DON + Medical Director co-sign");
  }
  const isDeath = input.dischargeType === "death";
  if (isDeath) {
    checkDeathCertifier({
      deathAt: input.deathAt ?? "",
      today: input.today ?? input.deathAt ?? "",
      certifierIsCredentialed: input.deathCertifierCredentialed ?? false,
    });
  }
  const effects: SideEffect[] = [
    { kind: "end_election_period", cause: "discharge" },
    { kind: "end_level_of_care" },
    { kind: "audit" },
    { kind: "outbox", event: isDeath ? "m6.discharge.death" : "m6.discharge.created" },
  ];
  if (isDeath) effects.push({ kind: "outbox", event: "m6.bereavement.eligible" });
  return { effects };
}
