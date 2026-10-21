// apps/backend/src/modules/22-documents/extraction/sud-content-gate.ts — GAP-067: the 42 CFR Part 2
// need-to-know gate on the DocLens review surface.
//
// `getWorkspace` decrypts every candidate value and the SUD evidence, and `renderPage` serves the raw page —
// for any `intake.review` holder. A batch whose detection is pending or confirmed carries Part 2 content, so
// the reviewer must ALSO be a high-risk-licensed reviewer (`extraction_reviewer_eligible`, `sudReview` arm)
// and pass the Part 2 need-to-know check. The need-to-know depends on the batch's detection state (spec §7.4
// W4: the reviewer adjudicates a detection BEFORE any consent exists — consent is captured later, step 7):
//   not_detected / rejected  not Part 2 content (a rejection is a documented false positive): readable.
//   detected (pending)       the licensed reviewer is adjudicating it — internal use by the receiving program,
//                            so eligibility alone suffices. Without this the RN who must confirm or reject the
//                            detection would decide blind.
//   confirmed                Part 2 content again: eligibility AND `sud_consent_present` for the batch's patient.
// The route composes both predicates through `requireAbac` and hands the service a {@link SudContentAccess};
// the service applies this gate to what it loaded. Enforcing at both layers means a second caller of the
// service (a live suite, a future route) that forgets to supply access gets redaction, never content: the
// default is DENY.
//
// Pure functions only — no DB, no seam — so the policy is unit-tested without a server.
import { ForbiddenError } from "@chartwarden/types";

/** The batch SUD detection state (owned here so this gate has no import back into the workspace builder). */
export type SudStatus = "not_detected" | "detected" | "confirmed" | "rejected";

/** The slice of a workspace candidate the redaction reads or rewrites (structural: no import cycle). */
interface RedactableCandidate {
  readonly sudDetected: boolean;
  readonly value: string | null;
  readonly redacted: boolean;
  readonly codingFlags: readonly unknown[];
  readonly vision: { readonly observedValue: string | null };
  readonly decision: {
    readonly editedValue: string | null;
    readonly reason: string | null;
  } | null;
}

/** The slice of a workspace the redaction reads or rewrites. */
interface RedactableWorkspace<C extends RedactableCandidate> {
  readonly sud: { readonly contentRedacted: boolean; readonly indicators: readonly unknown[] };
  readonly candidates: readonly C[];
}

/**
 * The two probes the route composes from named ABAC predicates. Each answers for THIS caller. The consent
 * probe is asked about the batch's own (server-loaded) patient — never a request value. Supplied by the route;
 * absent means "no".
 */
export interface SudContentAccess {
  /** The licence arm of `extraction_reviewer_eligible` (`sudReview`). */
  readonly reviewerEligible: () => Promise<boolean>;
  /** M39 `sud_consent_present` for `patientId`. */
  readonly consentPresent: (patientId: string) => Promise<boolean>;
}

/** The server-loaded facts of the batch the gate decides about. */
export interface SudContentTarget {
  readonly sudStatus: SudStatus;
  readonly patientId: string | null;
}

/** The batch states in which its document holds Part 2 content: a pending or a confirmed detection. */
const SUD_CONTENT_STATES: readonly SudStatus[] = ["detected", "confirmed"];

export const isSudContentState = (status: SudStatus): boolean =>
  SUD_CONTENT_STATES.includes(status);

/** A probe that throws or answers anything but `true` is a `false`. */
async function probe(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await fn()) === true;
  } catch {
    return false;
  }
}

/**
 * May this caller read Part 2 content of the batch? Fail closed: no access, a throw, or anything but `true`
 * is a denial. A non-Part-2 state needs nothing; a pending detection needs only the licence (the consent
 * probe is not even consulted, so a down consent seam cannot blind the adjudicator); a confirmed batch needs
 * the licence AND consent for its patient (a patientless confirmed batch has no consent to evaluate: denied).
 */
export async function resolveSudContentAccess(
  access: SudContentAccess | undefined,
  target: SudContentTarget,
): Promise<boolean> {
  if (!isSudContentState(target.sudStatus)) return true;
  if (!access) return false;
  if (!(await probe(access.reviewerEligible))) return false;
  if (target.sudStatus === "detected") return true;
  const { patientId } = target;
  if (!patientId) return false;
  return probe(() => access.consentPresent(patientId));
}

const redactCandidate = <C extends RedactableCandidate>(c: C): C =>
  c.sudDetected
    ? ({
        ...c,
        value: null,
        redacted: true,
        codingFlags: [],
        vision: { ...c.vision, observedValue: null },
        decision: c.decision ? { ...c.decision, editedValue: null, reason: null } : null,
      } as C)
    : c;

/**
 * The workspace with every SUD-detected candidate's value / vision observation / coding flags / decision text
 * and the SUD evidence removed. Returns a new object; the input is untouched. Batch-level facts (status,
 * detector ref, who resolved it) stay — they are flags, not content.
 */
export function redactSudWorkspace<C extends RedactableCandidate, W extends RedactableWorkspace<C>>(
  workspace: W,
): W {
  return {
    ...workspace,
    sud: { ...workspace.sud, contentRedacted: true, indicators: [] },
    candidates: workspace.candidates.map(redactCandidate),
  };
}

/** The page image is the whole source page, so a Part 2 batch's image needs the same access (403). */
export function assertSudPageReadable(sudStatus: SudStatus, allowed: boolean): void {
  if (isSudContentState(sudStatus) && !allowed) {
    throw new ForbiddenError(
      "this batch holds 42 CFR Part 2 content; viewing it needs a licensed reviewer with a Part 2 need-to-know",
    );
  }
}
