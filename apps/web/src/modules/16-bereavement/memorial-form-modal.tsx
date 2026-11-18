// apps/web/src/modules/16-bereavement — the memorial-service form (ADR-0109 D10, routes 68 / 70), shared by "New memorial service" (no
// version: a create) and "Edit" (the version the page READ goes in `If-Match`). One Idempotency-Key per attempt; a lost response retries
// under the same key. Nothing here writes invitation wording: that is the invitation mailing run's, written by staff on its own page.
import { Button, useApiClient, useAttemptKey } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { errorMessage, isStaleVersion, isStaleWrite } from "./bereavement-api";
import { FormShell, SelectField, TextAreaField, TextField } from "./bereavement-ui";
import { intOrNull, isHttpsUrl, isoToLocal, localToIso, orNull } from "./program-status";
import { type Memorial, type MemorialBody, createMemorial, updateMemorial } from "./programs-api";

/** The bereavement program runs 13 months: the default invitation window. */
const DEFAULT_WINDOW_MONTHS = "13";

interface Draft {
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  modality: "in_person" | "virtual";
  venueText: string;
  joinUrl: string;
  capacity: string;
  rsvpBy: string;
  inviteWindowMonths: string;
}

const draftOf = (service: Memorial | null): Draft => ({
  title: service?.title ?? "",
  description: service?.description ?? "",
  startsAt: isoToLocal(service?.startsAt),
  endsAt: isoToLocal(service?.endsAt),
  modality: service?.modality ?? "in_person",
  venueText: service?.venueText ?? "",
  joinUrl: service?.joinUrl ?? "",
  capacity: service?.capacity == null ? "" : String(service.capacity),
  rsvpBy: service?.rsvpBy?.slice(0, 10) ?? "",
  inviteWindowMonths: service ? String(service.inviteWindowMonths) : DEFAULT_WINDOW_MONTHS,
});

/** The body, or the first problem a reader must fix (said before any request). `keepJoinUrl`: the join-link field was left as read, so the
 * body omits `joinUrl` (the server keeps it); null would CLEAR a link this reader may not be shown. */
function toBody(d: Draft, keepJoinUrl: boolean): MemorialBody | string {
  const startsAt = localToIso(d.startsAt);
  const endsAt = localToIso(d.endsAt);
  if (!d.title.trim()) return "Give the service a title.";
  if (!startsAt || !endsAt) return "Enter when the service starts and ends.";
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return "The end must be after the start.";
  const join = orNull(d.joinUrl);
  if (join !== null && !isHttpsUrl(join)) return "The join link must start with https://.";
  const capacity = intOrNull(d.capacity);
  if (d.capacity.trim() !== "" && (capacity === null || capacity < 1))
    return "Capacity must be a whole number of at least 1, or left blank.";
  const months = intOrNull(d.inviteWindowMonths);
  if (months === null || months < 1)
    return "The invitation window must be a whole number of months.";
  return {
    title: d.title.trim(),
    description: orNull(d.description),
    startsAt,
    endsAt,
    modality: d.modality,
    venueText: orNull(d.venueText),
    ...(keepJoinUrl ? {} : { joinUrl: join }),
    capacity,
    rsvpBy: orNull(d.rsvpBy),
    inviteWindowMonths: months,
  };
}

interface MemorialFormProps {
  /** null: create a new service; otherwise edit this one at the version read. */
  service: Memorial | null;
  onClose: () => void;
  onSaved: (saved: Memorial) => void;
  /** An edit was refused because the service moved: the page closes this form, says `message` and reloads. */
  onStale?: (message: string) => void;
}

/** The form as a dialog over the page: the service's own detail page. */
export const MemorialFormModal = (props: MemorialFormProps): JSX.Element => (
  <MemorialForm {...props} presentation="modal" />
);

/** The same form as a drawer beside the list: the memorial services list screen. */
export const MemorialFormDrawer = (props: MemorialFormProps): JSX.Element => (
  <MemorialForm {...props} presentation="drawer" />
);

function MemorialForm({
  service,
  onClose,
  onSaved,
  onStale,
  presentation,
}: MemorialFormProps & { presentation: "modal" | "drawer" }): JSX.Element {
  const client = useApiClient();
  const keys = useAttemptKey();
  const [draft, setDraft] = useState<Draft>(() => draftOf(service));
  // The link as the reader saw it when the dialog OPENED: a late reload of `service` must not read as "changed" (and clear the stored link).
  const [openedJoinUrl] = useState(() => draftOf(service).joinUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set =
    <K extends keyof Draft>(field: K) =>
    (value: string) =>
      setDraft((prev) => ({ ...prev, [field]: value }));

  const save = async (): Promise<void> => {
    const body = toBody(draft, service !== null && draft.joinUrl === openedJoinUrl);
    if (typeof body === "string") {
      setError(body);
      return;
    }
    setBusy(true);
    setError(null);
    const key = keys.keyFor(`${service?.version ?? "new"}:${JSON.stringify(body)}`);
    const res = service
      ? await updateMemorial(client, service.serviceId, service.version, body, key)
      : await createMemorial(client, body, key);
    keys.settle(res.status, res.error);
    setBusy(false);
    if (res.error || !res.data) {
      const message = errorMessage(res.error, "The memorial service could not be saved.");
      if (service !== null && isStaleWrite(res.status) && onStale) {
        onStale(
          isStaleVersion(res.status, res.error)
            ? "This service changed while you were editing it. The page has been refreshed: check it and try again."
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
    <FormShell
      presentation={presentation}
      title={service ? "Edit memorial service" : "New memorial service"}
      onClose={onClose}
      busy={busy}
      error={error}
      save={
        <Button tone="primary" type="button" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <TextField label="Title" value={draft.title} onChange={set("title")} maxLength={200} />
      <TextAreaField label="Description" value={draft.description} onChange={set("description")} />
      <TextField
        label="Starts"
        type="datetime-local"
        value={draft.startsAt}
        onChange={set("startsAt")}
      />
      <TextField label="Ends" type="datetime-local" value={draft.endsAt} onChange={set("endsAt")} />
      <SelectField
        label="Modality"
        value={draft.modality}
        onChange={(v) => set("modality")(v === "virtual" ? "virtual" : "in_person")}
        options={[
          { value: "in_person", label: "In person" },
          { value: "virtual", label: "Virtual" },
        ]}
      />
      <TextField label="Venue" value={draft.venueText} onChange={set("venueText")} />
      <TextField
        label="Join link (https)"
        value={draft.joinUrl}
        onChange={set("joinUrl")}
        placeholder="https://"
      />
      <TextField label="Capacity" type="number" value={draft.capacity} onChange={set("capacity")} />
      <TextField label="RSVP by" type="date" value={draft.rsvpBy} onChange={set("rsvpBy")} />
      <TextField
        label="Invite families bereaved within (months)"
        type="number"
        value={draft.inviteWindowMonths}
        onChange={set("inviteWindowMonths")}
      />
    </FormShell>
  );
}
