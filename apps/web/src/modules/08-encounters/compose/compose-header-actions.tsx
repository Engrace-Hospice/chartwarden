// apps/web/src/modules/08-encounters/compose — the composer's header action bar: back to the encounter, its state, the record, vitals, save
// and finalize (moved out of encounter-compose.tsx).
import { Button, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { headerActions } from "../encounter-compose-styles";
import { ENCOUNTER_TONE, stateLabel } from "../encounter-status";
import type { EncounterView } from "../encounters-api";

export interface ComposeHeaderActionsProps {
  readonly status: EncounterView["status"];
  readonly busy: boolean;
  readonly frozen: boolean;
  readonly saving: boolean;
  readonly vitalsInSection: boolean;
  readonly vitalsOpen: boolean;
  readonly onOpenRecord: () => void;
  readonly onVitals: () => void;
  readonly onSave: () => void;
  readonly onFinalize: () => void;
}

export function ComposeHeaderActions({
  status,
  busy,
  frozen,
  saving,
  vitalsInSection,
  vitalsOpen,
  onOpenRecord,
  onVitals,
  onSave,
  onFinalize,
}: ComposeHeaderActionsProps): JSX.Element {
  return (
    <div className="wx-encounter-compose-actions" style={headerActions}>
      <Button tone="tertiary" onClick={onOpenRecord} disabled={busy}>
        Back to encounter
      </Button>
      <StatusPill label={stateLabel(status)} tone={ENCOUNTER_TONE[status] ?? "neutral"} />

      <Button tone="tertiary" onClick={onOpenRecord} disabled={busy}>
        Open record
      </Button>

      <Button tone="tertiary" onClick={onVitals} disabled={frozen || busy}>
        {!vitalsInSection && vitalsOpen ? "Close vitals" : "Vitals"}
      </Button>

      <Button tone="tertiary" onClick={onSave} disabled={busy || frozen}>
        {saving ? "Saving…" : "Save draft"}
      </Button>

      <Button onClick={onFinalize} disabled={busy || frozen}>
        Finalize note
      </Button>
    </div>
  );
}
