// apps/web/src/modules/08-encounters — the cosigner's ceremony as a hook: acknowledge, sign (attestation) and supervisor release (reason of at
// least 40 characters, fresh step-up), for a note's cosignature request and for the request an amending addendum opened (ADR-0114 VN-D30,
// S1 PR E4). It was inline in encounter-read.tsx for the note; it is written once here and the subject only picks the route.
//
// The server owns every decision (who may act, step-up, the §2.4 graph); this sends the step and words the answer (`cosign-refusal.ts`).
// A 401 goes to sign-in. A step-up refusal keeps the dialog open with the real `/step-up` screen offered beside its sentence, so a typed
// release reason is not lost to a redirect. The release carries `stepUpAuthAt`, a click-time clock value the route requires (and ignores:
// step-up provenance comes from the session), under one key and one first-attempt time per intent, so a retry after a lost reply is identical.
import { sendWrite, useApiClient, useIdempotencyKeeper } from "@chartwarden/ui";
import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { CosignStep } from "./cosign-model";
import { cosignRefusalMessage, isStepUpRefusal } from "./cosign-refusal";
import { type FieldErrors, fieldErrorsFrom } from "./read-errors";
import { useIsMounted } from "./use-is-mounted";
import { authFailureRedirect } from "./write-workflow";

export type CosignSubject =
  | { readonly kind: "note"; readonly encounterId: string }
  | { readonly kind: "addendum"; readonly encounterId: string; readonly addendumId: string };

/** The least a supervisor's release reason may be (also the route's schema and a database check). */
export const RELEASE_REASON_MIN = 40;

const NOTE = "/api/v1/encounters/{encounterId}/cosignature";
const AMENDMENT = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/cosignature";
const SUFFIX: Readonly<Record<CosignStep, string>> = {
  acknowledge: "/acknowledge",
  sign: "/sign",
  release: "/supervisor-release",
};

const pathOf = (subject: CosignSubject, step: CosignStep): string =>
  `${subject.kind === "note" ? NOTE : AMENDMENT}${SUFFIX[step]}`;

const paramsOf = (subject: CosignSubject) => ({
  path:
    subject.kind === "note"
      ? { encounterId: subject.encounterId }
      : { encounterId: subject.encounterId, addendumId: subject.addendumId },
});

interface WriteOutcome {
  readonly error?: {
    readonly message?: string;
    readonly error?: { readonly code?: string; readonly message?: string };
  };
  readonly response?: Response;
}

const UNREACHABLE =
  "Could not reach the server. Check your connection and try again; if it keeps failing, reload the page to see whether the action already went through.";

export interface CosignCeremony {
  /** The dialog that is open; null when none is. */
  readonly step: CosignStep | null;
  readonly busy: boolean;
  /** What went wrong, in words with the next step; null when nothing has. */
  readonly error: string | null;
  /** The real re-authentication screen, when the refusal was a missing step-up. */
  readonly reauthenticateHref: string | null;
  readonly reason: string;
  readonly reasonError: string | null;
  open(step: CosignStep): void;
  close(): void;
  setReason(next: string): void;
  commit(): Promise<void>;
}

/** `onDone` runs after a step lands, so the screen reads the request (and the page) again. */
export function useCosignCeremony(subject: CosignSubject, onDone: () => void): CosignCeremony {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const mounted = useIsMounted();
  const releaseKeeper = useIdempotencyKeeper();
  const [step, setStep] = useState<CosignStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauthenticateHref, setReauthenticateHref] = useState<string | null>(null);
  const [reason, setReasonText] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const close = useCallback(() => {
    setStep(null);
    setReasonText("");
    setReasonError(null);
    setError(null);
    setReauthenticateHref(null);
  }, []);

  const open = useCallback(
    (next: CosignStep) => {
      close();
      setStep(next);
    },
    [close],
  );

  const setReason = useCallback((next: string) => {
    setReasonText(next);
    setReasonError(null);
  }, []);

  const send = useCallback(
    async (which: CosignStep): Promise<WriteOutcome | "unreachable"> => {
      const path = pathOf(subject, which);
      const params = paramsOf(subject);
      try {
        if (which === "release") {
          const trimmed = reason.trim();
          const sent = await sendWrite(
            releaseKeeper,
            `${subject.encounterId}|${subject.kind}|${subject.kind === "addendum" ? subject.addendumId : ""}|release|${trimmed}`,
            (key, stampedAt) =>
              client.POST(
                path as never,
                {
                  params,
                  body: { reason: trimmed, stepUpAuthAt: stampedAt },
                  headers: { "Idempotency-Key": key },
                } as never,
              ) as Promise<WriteOutcome>,
          );
          if (sent.status === "unreachable") return "unreachable";
          // A refusal with an empty body (a gateway 5xx) is still a refusal: never read it as a success.
          return sent.status === "refused" && sent.res.error === undefined
            ? { ...sent.res, error: { message: "The action was refused." } }
            : sent.res;
        }
        const body = which === "sign" ? { attestationConfirmed: true as const } : undefined;
        return (await client.POST(
          path as never,
          { params, ...(body ? { body } : {}) } as never,
        )) as WriteOutcome;
      } catch {
        // An offline or aborted request rejects rather than resolving to an error envelope: never leave `busy` stuck.
        return "unreachable";
      }
    },
    [client, subject, reason, releaseKeeper],
  );

  const commit = useCallback(async () => {
    if (step === null) return;
    if (step === "release" && reason.trim().length < RELEASE_REASON_MIN) {
      setError(null);
      setReasonError(`Provide a reason of at least ${RELEASE_REASON_MIN} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    setReauthenticateHref(null);
    setReasonError(null);
    const outcome = await send(step);
    // The page the person was on may be gone by now (a request that took long); a late answer sets nothing and moves nothing.
    if (!mounted.current) return;
    if (outcome === "unreachable") {
      setBusy(false);
      setError(UNREACHABLE);
      return;
    }
    const err = outcome.error;
    if (!err) {
      setBusy(false);
      close();
      onDone();
      return;
    }
    const status = outcome.response?.status;
    const code = err.error?.code;
    const message = err.error?.message ?? err.message;
    const path = `${location.pathname}${location.search}`;
    if (status === 401) {
      navigate(authFailureRedirect(status, code, path, message) ?? "/login");
      return;
    }
    setBusy(false);
    const mapped: FieldErrors = step === "release" ? fieldErrorsFrom(err, ["reason"]) : {};
    if (mapped.reason) {
      setReasonError(mapped.reason);
      return;
    }
    if (isStepUpRefusal({ status, code, message })) {
      setReauthenticateHref(`/step-up?returnTo=${encodeURIComponent(path)}`);
    }
    setError(cosignRefusalMessage({ status, code, step, subject: subject.kind }));
  }, [step, reason, send, mounted, close, onDone, navigate, location, subject.kind]);

  return {
    step,
    busy,
    error,
    reauthenticateHref,
    reason,
    reasonError,
    open,
    close,
    setReason,
    commit,
  };
}
