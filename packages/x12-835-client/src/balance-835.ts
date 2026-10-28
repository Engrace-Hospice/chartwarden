// @chartwarden/x12-835-client — 835 balancing rules. PURE; all arithmetic in integer cents (no float drift).
// Any imbalance throws an X12_835_UNBALANCED error: a remittance that does not foot is never posted.
//
// Current-behavior limits (deliberate; follow-ups, not silent):
//  - sum(SVC02) = CLP03 is enforced for every claim with service lines (not yet checked against MAC
//    companion guides);
//  - CLP05 must equal the PR adjustments exactly (an absent CLP05 counts as 0);
//  - interest carried inside CLP04 is not modelled separately;
//  - claim and line CAS are additive in the claim balance.
import { X12ParseError } from "./x12-tokenizer";

/**
 * CLP02 23 (forwarded to another payer) and 25 (predetermination) are not adjudicated payments: they skip
 * the charge/CAS balance but MUST carry CLP04 = 0, so an exempt claim can never put money into BPR02.
 */
const NO_PAYMENT_STATUS: ReadonlySet<number> = new Set([23, 25]);

export interface CentsAdjustment {
  readonly groupCode: string;
  readonly cents: number;
}
export interface LineCents {
  readonly charge: number;
  readonly paid: number;
  readonly adjustments: readonly CentsAdjustment[];
}
export interface ClaimCents {
  readonly statusCode: number;
  readonly charge: number;
  readonly paid: number;
  /** CLP05; 0 when absent. */
  readonly patientResponsibility: number;
  readonly adjustments: readonly CentsAdjustment[];
  readonly lines: readonly LineCents[];
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const usd = (c: number): string => (c / 100).toFixed(2);

function unbalanced(message: string): never {
  throw new X12ParseError("X12_835_UNBALANCED", message);
}

/**
 * Claim `n` (1-based, for PHI-free messages) must foot:
 *  - line:   SVC02 - SVC03 - sum(line CAS) = 0
 *  - lines:  sum(SVC02) = CLP03
 *  - claim:  CLP03 - CLP04 - sum(claim CAS + line CAS) = 0
 *  - CLP05 = sum(PR adjustments, claim + line level)
 */
export function checkClaimBalance(c: ClaimCents, n: number): void {
  if (NO_PAYMENT_STATUS.has(c.statusCode)) {
    if (c.paid !== 0) unbalanced(`claim ${n} has status ${c.statusCode} but a non-zero CLP04`);
    return;
  }
  c.lines.forEach((l, i) => {
    const adj = sum(l.adjustments.map((a) => a.cents));
    if (l.charge - l.paid - adj !== 0) {
      unbalanced(
        `claim ${n} service line ${i + 1} does not balance (charge - paid - CAS = ${usd(l.charge - l.paid - adj)})`,
      );
    }
  });
  if (c.lines.length > 0 && sum(c.lines.map((l) => l.charge)) !== c.charge) {
    unbalanced(`claim ${n} service-line charges do not sum to CLP03`);
  }
  const all = [...c.adjustments, ...c.lines.flatMap((l) => l.adjustments)];
  const diff = c.charge - c.paid - sum(all.map((a) => a.cents));
  if (diff !== 0) unbalanced(`claim ${n} does not balance (CLP03 - CLP04 - CAS = ${usd(diff)})`);
  const pr = sum(all.filter((a) => a.groupCode === "PR").map((a) => a.cents));
  if (pr !== c.patientResponsibility) {
    unbalanced(`claim ${n} patient responsibility (CLP05) disagrees with PR adjustments`);
  }
}

/** BPR02 must equal sum(CLP04) - sum(PLB amounts) (positive PLB reduces the payment). */
export function checkPaymentBalance(
  bprCents: number,
  claimPaid: readonly number[],
  plb: readonly number[],
): void {
  const expected = sum(claimPaid) - sum(plb);
  if (bprCents !== expected) {
    unbalanced(`BPR02 ${usd(bprCents)} != sum(CLP04) - sum(PLB) ${usd(expected)}`);
  }
}
