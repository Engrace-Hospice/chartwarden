// M36 WP 6.7 (ADR-0099) - the staff Family lane's failure sentences, the load gate and small helpers. A stale step-up navigates to the step-up page and says
// nothing; a 404 on create or reply is the calm "not turned on" state (the flag is off) and never guesses another reason; the one backend sentence ever
// shown is a 409 message (for example the second-person unblock rule).
import { FAMILY_NOT_ELIGIBLE_CODE, FAMILY_THREAD_CLOSED_CODE } from "@chartwarden/types";
import { Button, LoadingSpinner } from "@chartwarden/ui";
import type { JSX } from "react";
import { useFailureText } from "./export-common";
import { ft } from "./family-text";
import type { FamilyResult, LoadView } from "./use-family";

export type FamilyAction = "invite" | "reply" | "manage" | "settings";

const FAILED: Record<FamilyAction, Parameters<typeof ft>[0]> = {
  invite: "family.invite.failed",
  reply: "family.composer.failed",
  manage: "family.manage.failed",
  settings: "family.settings.failed",
};

export function useFamilyFailureText(): (
  result: FamilyResult<unknown>,
  action: FamilyAction,
) => string | null {
  const stepUpText = useFailureText();
  return (result, action) => {
    switch (result.kind) {
      case "ok":
        return null;
      case "step_up":
        return stepUpText(result);
      case "not_available":
        if (action === "invite") return ft("family.invite.notOn");
        return action === "reply" ? ft("family.composer.notOn") : ft("family.manage.notAvailable");
      case "limit":
        return action === "invite" ? ft("family.invite.limit") : ft("family.manage.limit");
      case "conflict":
        if (result.settingsMissing) return ft("family.settings.missing");
        if (result.code === FAMILY_NOT_ELIGIBLE_CODE) {
          return action === "reply"
            ? ft("family.composer.cannot")
            : ft("family.invite.notEligible");
        }
        if (result.code === FAMILY_THREAD_CLOSED_CODE) return ft("family.composer.closed");
        return result.message ?? ft(FAILED[action]);
      case "invalid":
        return ft(FAILED[action]);
      case "denied":
        return result.code === 401 ? ft("family.manage.signIn") : ft("family.manage.denied");
      default:
        return ft(FAILED[action]);
    }
  };
}

export function FamilyGate<T>({
  view,
  retry,
  failedText,
  deniedText,
  children,
}: {
  readonly view: LoadView<T>;
  readonly retry: () => void;
  readonly failedText: string;
  readonly deniedText: string;
  readonly children: (data: T) => JSX.Element;
}): JSX.Element {
  switch (view.status) {
    case "loading":
      return <LoadingSpinner />;
    case "error":
      return (
        <div className="wx-export-error" role="alert">
          <p>{failedText}</p>
          <Button type="button" tone="secondary" size="lg" onClick={retry}>
            {ft("family.lane.retry")}
          </Button>
        </div>
      );
    case "denied":
      return (
        <p className="wx-export-error" role="alert">
          {view.code === 401 ? ft("family.manage.signIn") : deniedText}
        </p>
      );
    case "ready":
      return children(view.data);
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "5 min", "3 h", "2 days": how long ago an instant was, for the unanswered age. */
export function ageText(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (Number.isNaN(elapsed)) return "";
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))} min`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h`;
  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "1 day" : `${days} days`;
}
