// M36 WP 6.10 (ADR-0102, PROPOSED) - every word the alarm sources screen shows. Provisional, pending the owner decisions in the ADR. The screen
// never calls an alarm an emergency, never says anyone is paged, and says on every view that it does not replace the nurse-call system.
export const TITLE = "Alarm sources";
export const BREADCRUMB = "Messaging";
export const INTRO =
  "Outside systems that send an alarm notice into ChartWarden. Each one appears as an alert in the inbox of the people your alert rules name.";
export const NOT_A_NURSE_CALL =
  "This is a notice only. It does not replace your nurse-call or monitoring system. Keep responding to alarms in the system they came from.";
export const READ_ONLY =
  "This list is read only. Creating a source, replacing its secret and disabling it are done through the API and each needs a fresh sign-in check.";
export const NO_SOURCES_TITLE = "No alarm sources";
export const NO_SOURCES_TEXT =
  "No outside system is set up to send alarm notices to this organisation.";
export const LOAD_DENIED = "You do not have access to alarm sources.";
export const REFRESH_FAILED =
  "The list could not be refreshed. The figures shown may be out of date.";
export const RETRY = "Retry";
export const NEVER = "Never";
export const kindWord = (alertType: string): string =>
  alertType === "alarm_ingest.nurse_call"
    ? "Nurse call"
    : alertType === "alarm_ingest.patient_sensor"
      ? "Bed or fall sensor"
      : alertType === "alarm_ingest.equipment"
        ? "Monitor or equipment"
        : "Other";
export const ceilingWord = (c: string): string =>
  c === "warn" ? "Up to warning" : "Information only";
