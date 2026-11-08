// apps/web/src/modules/16-bereavement — the support-group FORM (ADR-0109 D10, routes 54 and 56): create a draft group, or edit one.
//
// Create carries an `Idempotency-Key`; an edit also carries the group version the page READ in `If-Match`. A 412/409/404 on an edit means the
// group moved under the reader: the dialog closes and the page reloads and says why. While a group is open its schedule (recurrence) is fixed:
// only a draft's schedule can change, and a drop-in group has none. The format itself is chosen once, at creation.
import { useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { errorMessage, isStaleWrite } from "./bereavement-api";
import {
  CheckboxField,
  ErrorText,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  plainFieldset,
  primaryButtonStyle,
  useIdempotencyKey,
} from "./bereavement-ui";
import { intOrNull, isHttpsUrl, isUuid, orNull } from "./program-status";
import {
  type Group,
  type GroupCreateBody,
  type GroupRecurrence,
  createGroup,
  updateGroup,
} from "./programs-api";

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const RECURRENCE_DEFAULTS = {
  firstDate: "",
  startTime: "18:00",
  durationMinutes: "90",
  intervalWeeks: "1",
  count: "8",
};
type Draft = {
  name: string;
  description: string;
  format: GroupCreateBody["format"];
  modality: GroupCreateBody["modality"];
  enrollmentRequired: boolean;
  facilitatorKind: GroupCreateBody["facilitatorKind"];
  facilitatorUserId: string;
  coFacilitatorUserId: string;
  capacity: string;
  timezone: string;
  venueText: string;
  joinUrl: string;
  recurrence: Record<keyof typeof RECURRENCE_DEFAULTS, string>;
};

const draftOf = (group: Group | null): Draft => ({
  name: group?.name ?? "",
  description: group?.description ?? "",
  format: group?.format ?? "recurring",
  modality: group?.modality ?? "in_person",
  enrollmentRequired: group?.enrollmentRequired ?? true,
  facilitatorKind: group?.facilitatorKind ?? "staff",
  facilitatorUserId: group?.facilitatorUserId ?? "",
  coFacilitatorUserId: group?.coFacilitatorUserId ?? "",
  capacity: group?.capacity == null ? "" : String(group.capacity),
  timezone: group?.timezone ?? DEFAULT_TIMEZONE,
  venueText: group?.venueText ?? "",
  joinUrl: group?.joinUrl ?? "",
  recurrence: group?.recurrence
    ? {
        firstDate: group.recurrence.firstDate,
        startTime: group.recurrence.startTime,
        durationMinutes: String(group.recurrence.durationMinutes),
        intervalWeeks: String(group.recurrence.intervalWeeks),
        count: String(group.recurrence.count),
      }
    : RECURRENCE_DEFAULTS,
});

/** The recurrence the draft describes, or the sentence that says what is wrong with it. */
function recurrenceOf(r: Draft["recurrence"]): GroupRecurrence | string {
  const durationMinutes = intOrNull(r.durationMinutes);
  const intervalWeeks = intOrNull(r.intervalWeeks);
  const count = intOrNull(r.count);
  if (!r.firstDate || !r.startTime) return "Choose the first date and the start time.";
  if (durationMinutes === null || durationMinutes < 1) return "Enter a duration in minutes.";
  if (intervalWeeks === null || intervalWeeks < 1 || intervalWeeks > 4)
    return "Meet every 1 to 4 weeks.";
  if (count === null || count < 1 || count > 52) return "Plan between 1 and 52 sessions.";
  return { firstDate: r.firstDate, startTime: r.startTime, durationMinutes, intervalWeeks, count };
}

export function GroupFormModal({
  group,
  onClose,
  onSaved,
  onStale,
}: {
  /** null creates a new draft group. */
  group: Group | null;
  onClose: () => void;
  onSaved: (group: Group) => void;
  /** An edit was refused because the group moved: the page closes this dialog, says `message` and reloads. */
  onStale?: (message: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(group));
  // The link as the reader saw it when the dialog OPENED: a late reload of `group` (now without the plaintext link) must not read as "changed".
  const [openedJoinUrl] = useState(() => draftOf(group).joinUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useIdempotencyKey();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  const setRec = (key: keyof Draft["recurrence"], value: string) =>
    setDraft((prev) => ({ ...prev, recurrence: { ...prev.recurrence, [key]: value } }));
  const scheduleEditable =
    draft.format === "recurring" && (group === null || group.status === "draft");

  const problem = (): string | null => {
    if (!draft.name.trim()) return "Give the group a name.";
    if (!draft.facilitatorUserId.trim()) return "Enter the facilitator's membership id.";
    if (!isUuid(draft.facilitatorUserId))
      return "The facilitator's membership id is not a valid id.";
    if (draft.coFacilitatorUserId.trim() && !isUuid(draft.coFacilitatorUserId))
      return "The co-facilitator's membership id is not a valid id.";
    if (!draft.timezone.trim()) return "Enter the time zone (for example America/Chicago).";
    if (draft.capacity.trim() !== "" && (intOrNull(draft.capacity) ?? 0) < 1)
      return "Capacity must be a whole number of at least 1, or blank for no limit.";
    if (draft.joinUrl.trim() && !isHttpsUrl(draft.joinUrl.trim()))
      return "The join link must start with https://.";
    if (scheduleEditable) {
      const rec = recurrenceOf(draft.recurrence);
      if (typeof rec === "string") return rec;
    }
    return null;
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    const invalid = problem();
    if (invalid) {
      setError(invalid);
      return;
    }
    const common = {
      name: draft.name.trim(),
      description: orNull(draft.description),
      modality: draft.modality,
      enrollmentRequired: draft.enrollmentRequired,
      facilitatorKind: draft.facilitatorKind,
      facilitatorUserId: draft.facilitatorUserId.trim(),
      coFacilitatorUserId: orNull(draft.coFacilitatorUserId),
      capacity: intOrNull(draft.capacity),
      timezone: draft.timezone.trim(),
      venueText: orNull(draft.venueText),
      // Left as read: omitted, so the server keeps it (null would CLEAR a link this reader may not be shown).
      ...(group !== null && draft.joinUrl === openedJoinUrl
        ? {}
        : { joinUrl: orNull(draft.joinUrl) }),
    };
    const rec = scheduleEditable ? (recurrenceOf(draft.recurrence) as GroupRecurrence) : null;
    setBusy(true);
    setError(null);
    const fingerprint = JSON.stringify({ v: group?.version ?? 0, common, rec });
    const key = keys.keyFor(fingerprint);
    const res =
      group === null
        ? await createGroup(client, { ...common, format: draft.format, recurrence: rec }, key)
        : await updateGroup(
            client,
            group.groupId,
            group.version,
            rec ? { ...common, recurrence: rec } : common,
            key,
          );
    keys.settle(res.status);
    setBusy(false);
    if (res.error || !res.data) {
      const message = errorMessage(res.error, "The group could not be saved.");
      if (group !== null && isStaleWrite(res.status) && onStale) {
        onStale(
          res.status === 412
            ? "This group changed while you were editing it. The page has been refreshed: check it and try again."
            : message,
        );
        return;
      }
      setError(message);
      return;
    }
    onSaved(res.data);
  };

  return (
    <Modal
      title={group === null ? "New support group" : "Edit support group"}
      onClose={onClose}
      busy={busy}
      dirty
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : group === null ? "Create draft group" : "Save changes"}
        </button>
      }
    >
      <fieldset disabled={busy} style={plainFieldset}>
        <TextField label="Name" value={draft.name} onChange={(v) => set("name", v)} />
        <TextAreaField
          label="Description"
          rows={3}
          value={draft.description}
          onChange={(v) => set("description", v)}
        />
        {group === null ? (
          <SelectField
            label="Format"
            value={draft.format}
            onChange={(v) => set("format", v as Draft["format"])}
            options={[
              { value: "recurring", label: "Recurring (a set series of sessions)" },
              { value: "drop_in", label: "Drop-in (sessions added one at a time)" },
            ]}
          />
        ) : null}
        {scheduleEditable ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
              gap: "0.5rem",
            }}
          >
            <TextField
              label="First date"
              type="date"
              value={draft.recurrence.firstDate}
              onChange={(v) => setRec("firstDate", v)}
            />
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.7rem" }}>Start time</span>
              <input
                aria-label="Start time"
                type="time"
                value={draft.recurrence.startTime}
                onChange={(e) => setRec("startTime", e.target.value)}
              />
            </label>
            <TextField
              label="Duration (minutes)"
              type="number"
              value={draft.recurrence.durationMinutes}
              onChange={(v) => setRec("durationMinutes", v)}
            />
            <TextField
              label="Every how many weeks (1-4)"
              type="number"
              value={draft.recurrence.intervalWeeks}
              onChange={(v) => setRec("intervalWeeks", v)}
            />
            <TextField
              label="Number of sessions (1-52)"
              type="number"
              value={draft.recurrence.count}
              onChange={(v) => setRec("count", v)}
            />
          </div>
        ) : null}
        <SelectField
          label="Modality"
          value={draft.modality}
          onChange={(v) => set("modality", v as Draft["modality"])}
          options={[
            { value: "in_person", label: "In person" },
            { value: "virtual", label: "Virtual" },
          ]}
        />
        <CheckboxField
          label="Families must enroll to attend"
          checked={draft.enrollmentRequired}
          onChange={(v) => set("enrollmentRequired", v)}
        />
        <SelectField
          label="Facilitator kind"
          value={draft.facilitatorKind}
          onChange={(v) => set("facilitatorKind", v as Draft["facilitatorKind"])}
          options={[
            { value: "staff", label: "Staff" },
            { value: "volunteer", label: "Volunteer" },
          ]}
        />
        <TextField
          label="Facilitator membership id"
          value={draft.facilitatorUserId}
          onChange={(v) => set("facilitatorUserId", v)}
        />
        <TextField
          label="Co-facilitator membership id (optional)"
          value={draft.coFacilitatorUserId}
          onChange={(v) => set("coFacilitatorUserId", v)}
        />
        <TextField
          label="Capacity (blank for no limit)"
          type="number"
          value={draft.capacity}
          onChange={(v) => set("capacity", v)}
        />
        <TextField label="Time zone" value={draft.timezone} onChange={(v) => set("timezone", v)} />
        <TextField label="Venue" value={draft.venueText} onChange={(v) => set("venueText", v)} />
        <TextField
          label="Join link (https, optional)"
          value={draft.joinUrl}
          onChange={(v) => set("joinUrl", v)}
        />
      </fieldset>
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Modal>
  );
}
