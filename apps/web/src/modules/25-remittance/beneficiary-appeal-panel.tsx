import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the BENEFICIARY-FILED APPEALS section of a claim (milestone 13a): appeals the
// beneficiary or their representative filed, as the hospice recorded them, shown beside (never in place of) the hospice's
// own appeal chain. Nothing is computed or filed from here. The latest read wins, a failed reload keeps the list with a
// Retry, and the drawer is keyed on the appeal it shows.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import { ActionRail, ButtonRow, ErrorAlert, Hint, RetryAlert } from "./action-ui";
import { loadBeneficiaryAppeals } from "./beneficiary-api";
import { NO_BENEFICIARY_APPEALS, RECORDS_NOT_FILES } from "./beneficiary-copy";
import { BeneficiaryDetail } from "./beneficiary-detail";
import { BeneficiaryIntakeModal } from "./beneficiary-intake-modal";
import {
  BENEFICIARY_STATE_TONE,
  REPRESENTATIVE_STATUS_TONE,
  formatDay,
  humanize,
  toneOf,
} from "./remittance-status";
import { useGuardedLoad } from "./use-guarded-load";
import { useReloadOn } from "./use-reload-on";

export interface BeneficiaryAppealPanelProps {
  readonly claimId: string;
  /** Holds beneficiary_appeal.manage. */
  readonly canManage: boolean;
  /** Holds representative.read: appointments can be offered for linking. */
  readonly canReadAppointments: boolean;
  readonly refreshKey?: string | number;
  readonly onChanged?: () => void;
}

export function BeneficiaryAppealPanel(props: BeneficiaryAppealPanelProps): JSX.Element {
  const client = useApiClient();
  const load = useCallback(
    () => loadBeneficiaryAppeals(client, props.claimId),
    [client, props.claimId],
  );
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
      <section aria-label="Beneficiary-filed appeals">
        <RetryAlert
          message={`Beneficiary appeals unavailable: ${error}`}
          onRetry={() => void reload()}
        />
      </section>
    ) : (
      <LoadingSpinner />
    );
  }
  const selected = data.items.find((a) => a.id === selectedId) ?? null;
  return (
    <section aria-label="Beneficiary-filed appeals">
      <h3 className="wx-action-title">Beneficiary-filed appeals</h3>
      <Hint>{RECORDS_NOT_FILES}</Hint>
      {error ? (
        <>
          <ErrorAlert message={`Beneficiary appeals could not be refreshed: ${error}`} />
          <ButtonRow>
            <Button size="sm" tone="secondary" onClick={() => void reload()}>
              Retry
            </Button>
          </ButtonRow>
        </>
      ) : null}
      {data.items.length === 0 ? (
        <Hint>{NO_BENEFICIARY_APPEALS}</Hint>
      ) : (
        <ul className="wx-action-hint wx-action-list">
          {data.items.map((a) => (
            <li key={a.id}>
              <strong>{humanize(a.tierLabel)}</strong> · {humanize(a.filerKind)} ·{" "}
              <StatusPill
                label={humanize(a.state)}
                tone={toneOf(BENEFICIARY_STATE_TONE, a.state)}
              />
              {a.representativeStatus ? (
                <>
                  {" "}
                  <StatusPill
                    label={`Representative: ${humanize(a.representativeStatus)}`}
                    tone={toneOf(REPRESENTATIVE_STATUS_TONE, a.representativeStatus)}
                  />
                </>
              ) : null}{" "}
              · {a.filedOn ? `filed ${formatDay(a.filedOn)}` : "filed date not recorded"}{" "}
              <Button
                size="sm"
                tone="tertiary"
                aria-label={`Open beneficiary appeal ${humanize(a.tierLabel)}`}
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
            Record a beneficiary-filed appeal
          </Button>
        </ButtonRow>
      ) : null}
      {creating ? (
        <BeneficiaryIntakeModal
          claimId={props.claimId}
          canReadAppointments={props.canReadAppointments}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            changed();
          }}
        />
      ) : null}
      {selected ? (
        <ActionRail ariaLabel="Beneficiary appeal" onClose={() => setSelectedId(null)}>
          <BeneficiaryDetail
            key={`beneficiary-${selected.id}`}
            appeal={selected}
            canManage={props.canManage}
            onChanged={changed}
          />
        </ActionRail>
      ) : null}
    </section>
  );
}
