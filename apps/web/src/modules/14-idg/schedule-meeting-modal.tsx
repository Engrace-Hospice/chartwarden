// apps/web/src/modules/14-idg — "Schedule Meeting": POST /api/v1/idg/meetings (idg.schedule).
// The same modal shell as idg-meeting-modals.tsx (Modal + kit fields + in-place error, close only on
// success). The SERVER owns permission (403 is surfaced), overlap (409), the end/duration/past-start
// rules (422) and location scope (404); nothing here decides whether the caller may schedule.
import { Button, Modal, SelectField, TextField, useApiClient } from "@wardenx/ui";
import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { type MeetingView, scheduleMeeting } from "./idg-api";

export interface ScheduleMeetingModalProps {
  readonly open: boolean;
  readonly locations: readonly { id: string; name: string }[];
  /** The location the schedule is showing — the picker's default. */
  readonly defaultLocationId?: string;
  /** The caller's own membership — the coordinator default. */
  readonly meMembershipId?: string;
  /** membershipId → name, from GET /orgs/{id}/members (empty when unavailable). */
  readonly memberNames: ReadonlyMap<string, string>;
  readonly onClose: () => void;
  readonly onScheduled: (meeting: MeetingView) => void;
}

const shell = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
} as const;
const title = { margin: 0, fontSize: "1.05rem", fontWeight: 600 } as const;
const errorText = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" } as const;
const footer = { display: "flex", gap: "0.5rem", justifyContent: "flex-end" } as const;
const row = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" } as const;

const pad = (n: number): string => String(n).padStart(2, "0");
const todayLocal = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function ScheduleMeetingModal({
  open,
  locations,
  defaultLocationId,
  meMembershipId,
  memberNames,
  onClose,
  onScheduled,
}: ScheduleMeetingModalProps): JSX.Element | null {
  const client = useApiClient();
  const [locationId, setLocationId] = useState(defaultLocationId ?? "");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [coordinator, setCoordinator] = useState(meMembershipId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocationId(defaultLocationId ?? locations[0]?.id ?? "");
    setDate(todayLocal());
    setStart("");
    setEnd("");
    setCoordinator(meMembershipId ?? "");
    setBusy(false);
    setError(null);
    setStatus(null);
  }, [open, defaultLocationId, locations, meMembershipId]);

  const coordinatorOptions = useMemo(() => {
    const opts = [...memberNames.entries()].map(([value, label]) => ({
      value,
      label: value === meMembershipId ? `${label} (me)` : label,
    }));
    if (meMembershipId && !memberNames.has(meMembershipId)) {
      opts.unshift({ value: meMembershipId, label: "Me" });
    } else if (!meMembershipId) {
      // No known membership: the server defaults the coordinator to the caller.
      opts.unshift({ value: "", label: "Me (default)" });
    }
    return opts;
  }, [memberNames, meMembershipId]);

  if (!open) return null;

  const blocked = busy || locationId === "" || date === "" || start === "" || end === "";

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    const scheduledStart = new Date(`${date}T${start}`);
    const scheduledEnd = new Date(`${date}T${end}`);
    if (Number.isNaN(scheduledStart.getTime()) || Number.isNaN(scheduledEnd.getTime())) {
      setBusy(false);
      setStatus(422);
      setError("Enter a valid date and start and end time.");
      return;
    }
    const res = await scheduleMeeting(client, {
      locationId,
      scheduledStart: scheduledStart.toISOString(),
      scheduledEnd: scheduledEnd.toISOString(),
      ...(coordinator ? { coordinatorMembershipId: coordinator } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      setStatus(res.status);
      return;
    }
    onScheduled(res.value);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel="Schedule IDG meeting"
      width="30rem"
      accent="primary"
    >
      <div style={shell}>
        <h2 style={title}>Schedule IDG meeting</h2>
        <SelectField
          label="Location"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
        />
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <div style={row}>
          <TextField
            label="Start time"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <TextField
            label="End time"
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
        <SelectField
          label="Coordinator"
          value={coordinator}
          onChange={(e) => setCoordinator(e.target.value)}
          options={coordinatorOptions}
        />
        {error ? (
          <p role="alert" style={errorText} data-status={status ?? undefined}>
            {error}
          </p>
        ) : null}
        <div style={footer}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" onClick={() => void submit()} disabled={blocked}>
            {busy ? "Scheduling…" : "Schedule meeting"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
