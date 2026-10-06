// apps/backend/src/modules/22-documents/extraction/sud-content-gate.ts — GAP-067: the 42 CFR Part 2
// need-to-know gate on the DocLens review surface.
//
// `getWorkspace` decrypts every candidate value and the SUD evidence, and `renderPage` serves the raw page —
// for any `intake.review` holder. A batch whose detection is pending or confirmed carries Part 2 content, so
// the reviewer must ALSO be a high-risk-licensed reviewer (`extraction_reviewer_eligible`, `sudReview` arm)
// and pass the Part 2 need-to-know check (`sud_consent_present` for the batch's patient). The route composes
// both through `requireAbac` and hands the service a {@link SudContentAccess}; the service applies this gate
// to what it loaded. Enforcing at both layers means a second caller of the service (a live suite, a future
// route) that forgets to supply access gets redaction, never content: the default is DENY.
//
// Pure functions only — no DB, no seam — so the policy is unit-tested without a server.
import { ForbiddenError } from "@wardenx/types";

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
 * Whether THIS caller may see Part 2 content for a batch of `patientId`. The patient is the batch's own
 * (server-loaded) — never a request value. Supplied by the route; absent means "no".
 */
export type SudContentAccess = (patientId: string | null) => Promise<boolean>;

/** The batch states in which its document holds Part 2 content: a pending or a confirmed detection. */
const SUD_CONTENT_STATES: readonly SudStatus[] = ["detected", "confirmed"];

export const isSudContentState = (status: SudStatus): boolean =>
  SUD_CONTENT_STATES.includes(status);

/** Fail closed: no access function, a patientless batch, a throw, or anything but `true` is a denial. */
export async function resolveSudContentAccess(
  access: SudContentAccess | undefined,
  patientId: string | null,
): Promise<boolean> {
  if (!access) return false;
  try {
    return (await access(patientId)) === true;
  } catch {
    return false;
  }
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
