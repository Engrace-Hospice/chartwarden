// apps/web/src/shell — what a panel that keeps its own form tells the screen that hosts it. The visit-note composer mounts several (ADLs,
// nutrition, wounds, the plan of care): each saves on its own button, so the composer cannot see their unsaved input or their writes in
// flight unless they say so. Without that, the leave prompt never fires for them and "Finalize" can race a panel's save.
import { useEffect, useRef } from "react";

export interface PanelStatus {
  /** The panel holds input that was typed and not saved: leaving the screen would lose it. */
  readonly dirty: boolean;
  /** The panel has a write in flight. */
  readonly saving: boolean;
  /** The panel's record is saved on the server, which the visit note counts as documenting the section the panel belongs to. */
  readonly recorded?: boolean;
}

export const IDLE_PANEL: PanelStatus = { dirty: false, saving: false, recorded: false };

export type PanelStatusListener = (status: PanelStatus) => void;

/**
 * Tell `onStatusChange` the panel's status whenever it changes, and that it is idle once the panel is gone. A panel that only reloads
 * its record (its form unmounts and comes back) keeps the last `recorded` it knew, so the section it documents does not flip back to
 * "required" for the moment of the reload.
 */
export function useReportPanelStatus(
  onStatusChange: PanelStatusListener | undefined,
  { dirty, saving, recorded = false }: PanelStatus,
): void {
  // The listener is read through a ref so an inline arrow from the host does not re-report on every render. The ref is written in an
  // effect, declared first so the report below always reaches the listener of the same commit.
  const listener = useRef(onStatusChange);
  const lastRecorded = useRef(recorded);
  useEffect(() => {
    listener.current = onStatusChange;
  });
  useEffect(() => {
    lastRecorded.current = recorded;
    listener.current?.({ dirty, saving, recorded });
  }, [dirty, saving, recorded]);
  useEffect(
    () => () => {
      listener.current?.({ ...IDLE_PANEL, recorded: lastRecorded.current });
    },
    [],
  );
}

/** The status with `next` set for `key`; the same object when nothing changed, so a host's setState bails out of a re-render. */
export function withPanelStatus<K extends string>(
  statuses: Readonly<Partial<Record<K, PanelStatus>>>,
  key: K,
  next: PanelStatus,
): Readonly<Partial<Record<K, PanelStatus>>> {
  const held = statuses[key];
  const unchanged =
    held !== undefined &&
    held.dirty === next.dirty &&
    held.saving === next.saving &&
    (held.recorded ?? false) === (next.recorded ?? false);
  return unchanged ? statuses : { ...statuses, [key]: next };
}
