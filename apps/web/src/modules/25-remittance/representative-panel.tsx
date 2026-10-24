import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the APPOINTMENT OF REPRESENTATIVE section of a claim (milestone 13a): a record of who
// a beneficiary appointed, backed by the signed M22 document, confirmed against YOUR organization's own form version, and
// activated by a second person. It is a record only: it grants no portal access, consent or caregiver status. Nothing here
// states a CMS form, period or rule; every date is typed and an absent one reads as absent. The latest read wins, a failed
// reload keeps what was on screen with a Retry, and the drawer is keyed on the appointment it shows.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { ActionRail, ButtonRow, ErrorAlert, Hint, RetryAlert, WarningAlert } from "./action-ui";
import { type Appointment, loadAppointments } from "./beneficiary-api";
import { APPOINTMENT_GRANTS_NOTHING, NO_APPOINTMENT, VALIDITY_PASSED } from "./beneficiary-copy";
import { REPRESENTATIVE_STATUS_TONE, formatDay, humanize, toneOf } from "./remittance-status";
import { RepresentativeCreateModal } from "./representative-create-modal";
import { AppointmentDetail } from "./representative-detail";
import { useGuardedLoad } from "./use-guarded-load";
import { useReloadOn } from "./use-reload-on";

export interface RepresentativePanelProps {
  readonly claimId: string;
  /** Holds representative.manage: may record and edit drafts. */
  readonly canManage: boolean;
  /** Holds representative.verify: may activate or revoke (the server also needs a fresh step-up). */
  readonly canVerify: boolean;
  readonly refreshKey?: string | number;
  readonly onChanged?: () => void;
}

export function RepresentativePanel(props: RepresentativePanelProps): JSX.Element {
  const client = useApiClient();
  const load = useCallback(() => loadAppointments(client, props.claimId), [client, props.claimId]);
  const { data, error, load: reload } = useGuardedLoad(load);
  useReloadOn(reload, props.refreshKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const changed = (): void => {
    void reload();
    props.onChanged?.();
  };

  if (data === null) {
    return error ? (
      <section aria-label="Appointments of representative">
        <RetryAlert message={`Appointments unavailable: ${error}`} onRetry={() => void reload()} />
      </section>
    ) : (
      <LoadingSpinner />
    );
  }

  // The live row: after a reload (409, activation) the drawer reads the new version, never a stale copy.
  const selected: Appointment | null = data.items.find((a) => a.id === selectedId) ?? null;
  return (
    <section aria-label="Appointments of representative">
      <h3 className="wx-action-title">Appointment of representative</h3>
      <Hint>{APPOINTMENT_GRANTS_NOTHING}</Hint>
      {error ? (
        <>
          <ErrorAlert message={`Appointments could not be refreshed: ${error}`} />
          <ButtonRow>
            <Button size="sm" tone="secondary" onClick={() => void reload()}>
              Retry
            </Button>
          </ButtonRow>
        </>
      ) : null}
      {data.items.length === 0 ? (
        <WarningAlert>{NO_APPOINTMENT}</WarningAlert>
      ) : (
        <ul className="wx-action-hint wx-action-list">
          {data.items.map((a) => (
            <li key={a.id}>
              <StatusPill
                label={
                  a.status === "validity_end_passed_as_recorded"
                    ? "Validity end passed"
                    : humanize(a.status)
                }
                tone={toneOf(REPRESENTATIVE_STATUS_TONE, a.status)}
              />{" "}
              {a.representativeName} · {humanize(a.representativeKind)}
              {a.status === "validity_end_passed_as_recorded" ? (
                <>
                  {" "}
                  · {VALIDITY_PASSED} ({formatDay(a.validThroughOn)})
                </>
              ) : null}{" "}
              <Button
                size="sm"
                tone="tertiary"
                aria-label={`Open appointment of ${a.representativeName}`}
                onClick={() => setSelectedId(a.id)}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
      {props.canManage ? (
        <ButtonRow>
          <Button size="sm" tone="secondary" onClick={() => setCreating(true)}>
            Record an appointment
          </Button>
        </ButtonRow>
      ) : null}
      {creating ? (
        <RepresentativeCreateModal
          claimId={props.claimId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            changed();
          }}
        />
      ) : null}
      {selected ? (
        <ActionRail ariaLabel="Appointment of representative" onClose={() => setSelectedId(null)}>
          <AppointmentDetail
            key={`appointment-${selected.id}`}
            appointment={selected}
            canManage={props.canManage}
            canVerify={props.canVerify}
            onChanged={changed}
          />
        </ActionRail>
      ) : null}
    </section>
  );
}
