// M36 WP 4.6 (ADR-0073) - wording for "My notifications". The locked rows mirror the platform floor
// (PLATFORM_CHANNEL_FLOOR in @wardenx/messaging): the clinical lead signs off the list (spec section 4.6), so it lives here as plain text, one place.
export const PREFS_TITLE = "My notifications";
export const PREFS_SUB = "Choose how and when you are alerted. These settings apply to you only.";
export const PREFS_OFF = "Notification preferences are not turned on for your organization.";
export const PREFS_DENIED = "You do not have access to change notification preferences.";
export const PREFS_LOAD_FAILED = "Notification preferences could not be loaded.";
export const PREFS_SAVE_FAILED = "Could not save your preferences.";
export const PREFS_SAVED = "Preferences saved.";
export const PREFS_UNSAVED = "You have unsaved changes.";

export interface LockedQuietRow {
  readonly id: string;
  readonly label: string;
  readonly delivered: string;
}

export const LOCKED_REASON =
  "Set by the platform; cannot be turned off. Quiet hours never apply to it.";

export const LOCKED_QUIET_ROWS: readonly LockedQuietRow[] = [
  { id: "urgent", label: "Urgent clinical requests", delivered: "Always delivered by push." },
  { id: "critical", label: "Critical requests", delivered: "Always delivered by push and SMS." },
];

export const SEVERITY_OPTIONS = [
  { value: "info", label: "Info and above" },
  { value: "warn", label: "Warnings and above" },
  { value: "critical", label: "Critical only" },
] as const;

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
