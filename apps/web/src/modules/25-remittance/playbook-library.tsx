import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the PLAYBOOK LIBRARY (hospice ADR/TPE/QIC PRD, milestone 9a-1). Your organization's
// own guidance for denial reasons: a list of playbooks (a code, optionally one MAC), which version is in force, and drafts
// waiting for a second person to review and publish. NOTHING ships with ChartWarden: a new organization sees an empty
// library and "your organization has not written any". The page says the text is not legal advice and not a CMS or MAC
// requirement. Rows open the version rail; "Write a playbook" opens the editor, pre-filled when a denial's panel sent the
// reader here (?new=1&kind=&code=&mac=).
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import { RetryAlert } from "./action-ui";
import { PLAYBOOK_CODE_KIND_LABEL, type PlaybookListItem, loadPlaybooks } from "./playbook-api";
import { PlaybookDetailPanel } from "./playbook-detail-panel";
import { PlaybookEditor } from "./playbook-editor";
import { PLAYBOOK_BANNER } from "./playbook-panel";

const mutedStyle = { color: "var(--color-on-surface-variant)", fontSize: "0.8rem" };

export function PlaybookLibrary(): JSX.Element {
  const client = useApiClient();
  const canAuthor = useSession()?.permissions?.includes("playbook.author") ?? false;
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<readonly PlaybookListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  // Requested by the ?new=1 link or the button; only offered once the session says the person may author (it can load late).
  const [writeRequested, setWriteRequested] = useState(params.get("new") === "1");
  const writing = writeRequested && canAuthor;
  const prefill = useRef({
    codeKind: params.get("kind") ?? undefined,
    code: params.get("code") ?? undefined,
    macName: params.get("mac") ?? undefined,
  });
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    const res = await loadPlaybooks(client);
    if (request !== latestRequest.current) return;
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setRows(res.value.items);
    setError(null);
    setLoaded(true);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const closeWriter = (): void => {
    setWriteRequested(false);
    if (params.has("new")) setParams({}, { replace: true });
  };
  const published = rows.filter((r) => r.publishedVersionNo !== null);
  const waiting = rows.filter((r) => r.hasDraft);
  const shown = (n: number): string | number => (loaded ? n : "—");

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Playbooks">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              {PLAYBOOK_BANNER} Nothing is provided by ChartWarden: every playbook here was written
              by your organization.
            </div>
          </PageHeader>
        }
        kpis={
          <KpiStrip>
            <KpiCard
              label="Playbooks"
              value={shown(rows.length)}
              detail="Written by your organization"
              tone="info"
              accentColor="var(--color-primary)"
            />
            <KpiCard
              label="Published"
              value={shown(published.length)}
              detail="Shown on matching denials"
              tone="neutral"
              accentColor="var(--color-outline-variant)"
            />
            <KpiCard
              label="Drafts To Review"
              value={shown(waiting.length)}
              detail="Need a second person to publish"
              tone={waiting.length > 0 ? "warning" : "neutral"}
              accentColor={
                waiting.length > 0 ? "var(--color-warning)" : "var(--color-outline-variant)"
              }
            />
          </KpiStrip>
        }
        filters={
          <div
            style={{ display: "flex", gap: "0.75rem", alignItems: "center", padding: "0 1.5rem" }}
          >
            {error && loaded ? <RetryAlert message={error} onRetry={() => void load()} /> : null}
            <span style={{ flex: 1 }} />
            {canAuthor ? (
              <Button
                size="sm"
                onClick={() => {
                  prefill.current = { codeKind: undefined, code: undefined, macName: undefined };
                  setWriteRequested(true);
                }}
              >
                Write a playbook
              </Button>
            ) : null}
          </div>
        }
        table={
          !loaded && !error ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : !loaded ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="Unavailable"
                description={error ?? ""}
                action={
                  <Button tone="secondary" size="sm" onClick={() => void load()}>
                    Retry
                  </Button>
                }
              />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No playbooks yet"
                description="Your organization has not written any. A playbook is guidance for one denial reason, with a source and a second person's review. Until you write one, a denial shows that none exists."
                action={
                  canAuthor ? (
                    <Button size="sm" onClick={() => setWriteRequested(true)}>
                      Write a playbook
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
              <table className="wx-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <caption className="wx-sr-only">Denial playbooks</caption>
                <thead>
                  <tr>
                    {["Reason", "MAC", "Title", "In force", "Draft", "Work"].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        style={{ ...mutedStyle, textAlign: "left", padding: "0.55rem 0.75rem" }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      style={{ borderTop: "1px solid var(--color-surface-container)" }}
                    >
                      <td style={{ padding: "0.55rem 0.75rem" }}>
                        {`${PLAYBOOK_CODE_KIND_LABEL[r.codeKind] ?? r.codeKind} ${r.code}`}
                      </td>
                      <td style={{ padding: "0.55rem 0.75rem" }}>{r.macName ?? "Any MAC"}</td>
                      <td style={{ padding: "0.55rem 0.75rem" }}>{r.title}</td>
                      <td style={{ padding: "0.55rem 0.75rem" }}>
                        {r.publishedVersionNo === null ? (
                          <span style={mutedStyle}>Nothing published</span>
                        ) : (
                          `Version ${r.publishedVersionNo} · ${(r.publishedAt ?? "").slice(0, 10)}`
                        )}
                      </td>
                      <td style={{ padding: "0.55rem 0.75rem" }}>
                        {r.hasDraft ? <StatusPill label="Awaiting review" tone="warning" /> : "—"}
                      </td>
                      <td style={{ padding: "0.55rem 0.75rem" }}>
                        <Button
                          size="sm"
                          tone="secondary"
                          aria-label={`Open playbook ${r.title}`}
                          onClick={() => setWorkingId(r.id)}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        detail={
          workingId ? (
            <PlaybookDetailPanel
              key={workingId}
              playbookId={workingId}
              onClose={() => setWorkingId(null)}
              onChanged={() => void load()}
            />
          ) : null
        }
        fullPageScroll
      />
      {writing ? (
        <PlaybookEditor
          mode={{ kind: "new", ...prefill.current }}
          onClose={closeWriter}
          onDone={() => {
            closeWriter();
            void load();
          }}
        />
      ) : null}
    </>
  );
}
