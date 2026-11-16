// apps/web/src/modules/10-hope — what a signer must do before a HOPE record is signed (R-05).
//
// Signing a timepoint and completing an SFV both create a signed CMS record, and the server now refuses
// either unless the request carries `attestationConfirmed: true` and the session has a FRESH step-up. This
// file is what the two signing surfaces (`hope-sign-dialog.tsx` and `hope-sfv-complete-dialog.tsx`) share:
//   • `HopeAttestation` — the required, labelled checkbox that gates the commit button. The wording it shows
//     is `HOPE_SIGN_ATTESTATION_STATEMENT` / `HOPE_SFV_ATTESTATION_STATEMENT` in `@chartwarden/types`, beside
//     the `HOPE_ATTESTATION_VERSION` the audit row records; a test there pins the text of every version;
//   • `useStepUpRedirect` — turns a `STEP_UP_REQUIRED` refusal into the `/step-up?returnTo=` route (the
//     shell's `stepUpRedirectFor`), so a stale session ends on the re-verification screen instead of a
//     dead end. A caller with typed input stashes it first (`hope-sfv-draft.ts`).
// Every other refusal is shown with the server's own words (`serverMessageOf` in `hope-api.ts`).
// Whether the attestation is VALID is the server's call; the checkbox only makes the signer say it.
import { useCallback, useId } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";

interface HopeAttestationProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** The wording the signer affirms: `HOPE_SIGN_ATTESTATION_STATEMENT` or `HOPE_SFV_ATTESTATION_STATEMENT`. */
  readonly statement: string;
  readonly disabled?: boolean;
}

/** The required attestation checkbox. The statement IS the label, so assistive tech announces what is affirmed. */
export function HopeAttestation({
  checked,
  onChange,
  statement,
  disabled = false,
}: HopeAttestationProps): JSX.Element {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={checked ? "wx-option-row checked" : "wx-option-row"}
      style={{ marginTop: "1rem" }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{statement}</span>
    </label>
  );
}

/**
 * Returns a function that sends the user to `/step-up?returnTo=<this screen>` when `error` is the step-up
 * refusal and reports whether it did. Any other error (including any other 403) returns false untouched, so
 * the caller shows it instead; redirecting a permanent "not allowed" into a ceremony would loop.
 * `stash` runs just before the redirect (and only then): a caller with typed input keeps it for the return.
 */
export function useStepUpRedirect(): (error: unknown, stash?: () => void) => boolean {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return useCallback(
    (error: unknown, stash?: () => void) => {
      const to = stepUpRedirectFor(error, `${pathname}${search}`);
      if (to === null) return false;
      stash?.();
      navigate(to);
      return true;
    },
    [navigate, pathname, search],
  );
}
