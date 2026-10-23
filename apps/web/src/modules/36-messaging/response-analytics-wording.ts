// M36 WP 6.2 (ADR-0092, PROPOSED) - words for the response analytics screen. Plain sentences; figures are aggregates, never people.
import type { AnalyticsGroupBy } from "@chartwarden/types";

export const TITLE = "Response analytics";
export const INTRO =
  "How quickly messages that ask for a response are answered, across the organisation. Counts and times only: no message, patient or person is shown.";
export const TODAY_NOTE = "Today is not included until the day ends. Ranges are whole UTC days.";
export const LOADING = "Loading response analytics";
export const LOAD_FAILED = "Response analytics could not be loaded.";
export const RETRY_LABEL = "Try again";
export const DENIED = "You no longer have access to this.";
export const SIGN_IN = "Your session has ended. Sign in again to continue.";
export const FLAG_OFF = "This feature is not turned on for your organization.";
export const OFFLINE = "You are offline. This list may be out of date.";
export const INSUFFICIENT_TITLE = "Not enough data to show";
export const insufficientText = (min: number): string =>
  `Figures are shown only when at least ${min} different people stand behind them, so no one person's response can be read from them. Choose a longer range, or check back when more responses have been recorded.`;

export const RANGE_LABEL = "Date range";
export const GROUP_LABEL = "Break down by";
export const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;
export const GROUPS: readonly { value: AnalyticsGroupBy; label: string }[] = [
  { value: "class", label: "Kind of request" },
  { value: "discipline", label: "Discipline" },
];

export const KPI_MEDIAN = "Median time to acknowledge";
export const KPI_IN_TIME = "Acknowledged before the deadline";
export const KPI_ESCALATION = "Escalation rate";
export const KPI_HANDOFF = "Median handoff acceptance time";
export const NOT_AVAILABLE = "Not available";
export const HANDOFF_WITHHELD = "Withheld: too few people";

export const TABLE_LABEL = "Response by group";
export const COL_GROUP = "Group";
export const COL_REQUESTS = "Requests";
export const COL_MEDIAN = "Median to acknowledge";
export const COL_IN_TIME = "Before deadline";
export const COL_ESCALATED = "Escalated";
export const BREAKDOWN_WITHHELD =
  "This breakdown is not shown: too few people stand behind the groups that would be left out, so showing the rest would reveal them.";
export const NO_GROUPS = "No group has enough people to be shown separately.";

export const suppressedText = (n: number): string =>
  n === 1
    ? "1 group is not shown because too few people stand behind it."
    : `${n} groups are not shown because too few people stand behind them.`;
export const provisionalText = (min: number): string =>
  `Minimum of ${min} people per figure. This threshold is provisional until HR and compliance review it. There is no view of an individual.`;

const CLASS_WORDS: Record<string, string> = {
  important: "Important",
  urgent: "Urgent",
  critical_symptom: "Critical symptom",
};
export const groupLabel = (by: AnalyticsGroupBy, group: string): string => {
  if (by === "class") return CLASS_WORDS[group] ?? group;
  return group === "unspecified" ? "No clinical role" : group.replaceAll("_", " ");
};

export const percent = (rate: number | null): string =>
  rate === null ? NOT_AVAILABLE : `${Math.round(rate * 100)}%`;

export function duration(seconds: number | null): string {
  if (seconds === null) return NOT_AVAILABLE;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} days`;
}
