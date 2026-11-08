// apps/admin/src/modules/34-saas-platform — the notices a tenant recorded as "filed outside ChartWarden" (NOEs and NOTRs), and the
// operator's way to take a mistaken or false record back. The tenant cannot undo such a record and a cancel refuses to hide a notice that
// is on file with Medicare, so without this a wrong record would be permanent. The withdrawal is PINNED to the record the operator read
// (If-Match = its recordedAt): a record the tenant re-recorded meanwhile is shown anew and needs a second, deliberate confirm; a record
// that is already gone closes the prompt. Ids, a state and dates only: nothing here names a patient.
import { EXTERNAL_NOTICE_FILING_LIST_CAP } from "@chartwarden/types";
import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  type operations,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { ONBOARDING_KEYS, useCan } from "./onboarding/permissions";
import { RecordSaveDialog } from "./onboarding/record-save-dialog";
import { RoleCannot } from "./onboarding/role-cannot";
import { StaleNotice } from "./onboarding/stale-notice";
import { useLoad } from "./onboarding/use-load";
import { useOpsWrite } from "./onboarding/use-ops-write";

type FilingList =
  operations["getApiV1PlatformTenantsByOrgSlugNoticefilings"]["responses"][200]["content"]["application/json"];
type Filing = FilingList["items"][number];

const LIST = "/api/v1/platform/tenants/{orgSlug}/notice-filings";
const NOE_WITHDRAW = "/api/v1/platform/tenants/{orgSlug}/noe-records/{id}/withdraw-external-filing";
const NOTR_WITHDRAW =
  "/api/v1/platform/tenants/{orgSlug}/notr-records/{id}/withdraw-external-filing";
const KIND_LABEL = { noe: "NOE", notr: "NOTR" } as const;

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "unknown");
const filedOn = (f: Filing): string => f.filedOn ?? "an unknown date";

/** What withdrawing this record does, said before the operator confirms it. */
function consequenceOf(f: Filing): string {
  const parts = [
    "The notice goes back to the state it was in before the tenant recorded it: it can be recorded or submitted again, and it returns to the deadline tracker.",
  ];
  if (f.breachStampFromRecord) {
    parts.push("The breach stamp this late record wrote is cleared with it.");
  } else if (f.windowBreachedAt) {
    parts.push("The breach stamp the deadline watchdog set stays.");
  }
  if (f.noticeKind === "notr") {
    parts.push("Withdrawing a NOTR record also reopens the prior election that record closed.");
  }
  return parts.join(" ");
}

function BreachCell({ filing }: { filing: Filing }): JSX.Element {
  if (!filing.windowBreachedAt) return <>None</>;
  return (
    <>
      <span className="wx-nums">{filing.windowBreachedAt}</span>
      {filing.breachStampFromRecord ? (
        <span className="wx-row-sub"> written by this record</span>
      ) : null}
    </>
  );
}

export function NoticeFilingsDrawer({
  orgSlug,
  onClose,
}: {
  orgSlug: string;
  onClose: () => void;
}): JSX.Element {
  const client = useApiClient();
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const list = useLoad<FilingList>(`notice-filings:${orgSlug}`, () =>
    client.GET(LIST, { params: { path: { orgSlug } } }),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const write = useOpsWrite();
  const mayWithdraw = useCan(ONBOARDING_KEYS.noticeWithdraw);

  const items = list.data?.items ?? [];
  const target =
    selectedId === null ? null : (items.find((f) => f.noticeId === selectedId) ?? null);

  function closeDialog(): void {
    write.clear();
    setSelectedId(null);
    setStale(false);
  }

  // The record being withdrawn is gone (another operator withdrew it): close the prompt rather than let it reappear for a later record.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only whether the record is still listed is the trigger.
  useEffect(() => {
    if (selectedId !== null && list.data !== null && target === null) closeDialog();
  }, [selectedId, list.data, target === null]);

  async function withdraw(reason: string): Promise<void> {
    if (!target?.recordedAt) return;
    const pin = target.recordedAt;
    const id = target.noticeId;
    const header = (key: string) => ({ "Idempotency-Key": key, "If-Match": pin });
    const outcome = await write.run(`withdraw:${id}:${pin}:${reason}`, (key) =>
      target.noticeKind === "noe"
        ? client.POST(NOE_WITHDRAW, {
            params: { path: { orgSlug, id }, header: header(key) },
            body: { reason },
          })
        : client.POST(NOTR_WITHDRAW, {
            params: { path: { orgSlug, id }, header: header(key) },
            body: { reason },
          }),
    );
    if (outcome.ok) {
      closeDialog();
      await list.reload(true);
    } else if (outcome.failure.kind === "conflict" || outcome.failure.kind === "precondition") {
      // The record changed (or is gone) since it was read: read it again; what it says now is what the operator confirms.
      setStale(true);
      await list.reload(true);
    }
  }

  return (
    <aside
      className="wx-admission-drawer md:col-span-2 xl:col-span-3"
      aria-label="Notices filed outside ChartWarden"
      {...drawer}
    >
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="file-check" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>Notices filed outside ChartWarden</h2>
          <span className="wx-row-sub">
            What this tenant recorded as filed with Medicare by someone else. Reading it is recorded
            in the audit trail.
          </span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        {list.loading && !list.data ? <LoadingSpinner label="Loading the records…" /> : null}
        {list.failure && !list.data ? (
          <>
            <InlineAlert tone="error">Could not load the records.</InlineAlert>
            <Button tone="secondary" size="sm" onClick={() => void list.reload()}>
              Try again
            </Button>
          </>
        ) : null}
        <StaleNotice stale={list.stale} onReload={() => void list.reload()} />
        {list.data && items.length === 0 ? (
          <p>This tenant has not recorded any notice as filed outside ChartWarden.</p>
        ) : null}
        {list.data?.truncated ? (
          <InlineAlert tone="info">
            Showing the most recent {EXTERNAL_NOTICE_FILING_LIST_CAP} records. Older ones are not
            listed here.
          </InlineAlert>
        ) : null}
        {items.length > 0 && !mayWithdraw ? (
          <RoleCannot what="withdraw a record filed outside ChartWarden" />
        ) : null}
        {items.length > 0 ? (
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Notices recorded as filed outside ChartWarden</caption>
            <thead>
              <tr>
                <th scope="col">Notice</th>
                <th scope="col">Filed on</th>
                <th scope="col">Recorded</th>
                <th scope="col">State</th>
                <th scope="col">Due</th>
                <th scope="col">Breach stamp</th>
                <th scope="col">
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.noticeId}>
                  <td>
                    <strong>{KIND_LABEL[f.noticeKind]}</strong>{" "}
                    <span className="wx-row-sub wx-data-md">{f.noticeId.slice(0, 8)}</span>
                  </td>
                  <td className="wx-nums">{f.filedOn ?? "—"}</td>
                  <td className="wx-nums">{when(f.recordedAt)}</td>
                  <td>{f.state}</td>
                  <td className="wx-nums">{f.windowTargetAt}</td>
                  <td>
                    <BreachCell filing={f} />
                  </td>
                  <td>
                    {mayWithdraw ? (
                      <Button
                        size="sm"
                        tone="tertiary"
                        aria-label={`Withdraw the ${KIND_LABEL[f.noticeKind]} record ${f.noticeId.slice(0, 8)}, filed on ${filedOn(f)}`}
                        onClick={() => {
                          write.clear();
                          setStale(false);
                          setSelectedId(f.noticeId);
                        }}
                      >
                        Withdraw
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <RecordSaveDialog
        open={target !== null}
        title={
          target ? `Withdraw the ${KIND_LABEL[target.noticeKind]} filing record` : "Withdraw record"
        }
        description={target ? consequenceOf(target) : undefined}
        confirmLabel="Withdraw record"
        tone="danger"
        stale={stale}
        record={
          target
            ? [
                { label: "Notice", value: `${KIND_LABEL[target.noticeKind]} ${target.noticeId}` },
                { label: "Filed on", value: filedOn(target) },
                { label: "Recorded by the tenant", value: when(target.recordedAt) },
                { label: "State", value: target.state },
              ]
            : undefined
        }
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void withdraw(reason)}
        onCancel={closeDialog}
      />
    </aside>
  );
}
