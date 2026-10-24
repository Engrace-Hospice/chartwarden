import { Button, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the playbook work rail (hospice ADR/TPE/QIC PRD milestone 9a-1): every version of one
// playbook, newest first, with the actions each state allows. A draft can be edited by its author side and PUBLISHED by a
// different person (the server refuses the author, and the message is shown); a published version is frozen, so a change is
// a new version; a published version can be retired, after which denials show "no playbook" until another is published.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { ActionRail, ButtonRow, ErrorAlert, Facts, Hint, NoticeAlert } from "./action-ui";
import {
  PLAYBOOK_CODE_KIND_LABEL,
  type PlaybookDetail,
  type PlaybookVersion,
  loadPlaybook,
  publishVersion,
  retireVersion,
} from "./playbook-api";
import { PlaybookEditor, type PlaybookEditorMode } from "./playbook-editor";
import { humanize } from "./remittance-status";

const STATUS_TONE: Record<string, "neutral" | "success" | "warning"> = {
  draft: "warning",
  published: "success",
  retired: "neutral",
};

export interface PlaybookDetailPanelProps {
  readonly playbookId: string;
  readonly onClose: () => void;
  /** Called after any change so the library list reloads. */
  readonly onChanged: () => void;
}

export function PlaybookDetailPanel({
  playbookId,
  onClose,
  onChanged,
}: PlaybookDetailPanelProps): JSX.Element {
  const client = useApiClient();
  const permissions = useSession()?.permissions;
  const can = (key: string): boolean => permissions?.includes(key) ?? false;
  const [detail, setDetail] = useState<PlaybookDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlaybookEditorMode | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const res = await loadPlaybook(client, playbookId);
    if (!mounted.current) return;
    if (res.ok) {
      setDetail(res.value);
      setLoadError(null);
    } else setLoadError(res.message);
  }, [client, playbookId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    call: () => Promise<{ ok: true } | { ok: false; message: string }>,
    done: string,
  ): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await call();
      if (!mounted.current) return;
      if (res.ok) setNotice(done);
      else setError(res.message);
      await load();
      onChanged();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const draft = detail?.versions.find((v) => v.status === "draft") ?? null;
  const latest = detail?.versions[0] ?? null;

  const versionRow = (v: PlaybookVersion): JSX.Element => (
    <li key={v.id}>
      <strong>{`Version ${v.versionNo}`}</strong>{" "}
      <StatusPill label={humanize(v.status)} tone={STATUS_TONE[v.status] ?? "neutral"} />
      <p>{v.summary}</p>
      <Facts
        items={[
          ["Source", v.sourceNote],
          ["Written by", v.authoredByMembershipId],
          ["Reviewed by", v.reviewedByMembershipId ?? "Not yet reviewed"],
          ["Published", v.publishedAt ? v.publishedAt.slice(0, 10) : "Not published"],
        ]}
      />
      <ol aria-label={`Steps of version ${v.versionNo}`}>
        {v.steps.map((s) => (
          <li key={s.key}>{s.text}</li>
        ))}
      </ol>
      <ButtonRow>
        {v.status === "draft" && can("playbook.author") ? (
          <Button
            tone="secondary"
            size="sm"
            disabled={busy}
            onClick={() => setEditing({ kind: "draft", draft: v })}
          >
            Edit draft
          </Button>
        ) : null}
        {v.status === "draft" && can("playbook.publish") ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(
                () => publishVersion(client, v.id, v.rowVersion),
                `Version ${v.versionNo} published.`,
              )
            }
          >
            Publish
          </Button>
        ) : null}
        {v.status === "published" && can("playbook.publish") ? (
          <Button
            tone="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(
                () => retireVersion(client, v.id, v.rowVersion),
                `Version ${v.versionNo} retired.`,
              )
            }
          >
            Retire
          </Button>
        ) : null}
      </ButtonRow>
      {v.status === "draft" ? (
        <Hint>A draft applies to no denial. Someone other than the author must publish it.</Hint>
      ) : null}
    </li>
  );

  return (
    <ActionRail ariaLabel={detail ? detail.title : "Playbook"} onClose={onClose}>
      {loadError ? (
        <>
          <ErrorAlert message={loadError} />
          <ButtonRow>
            <Button tone="secondary" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </ButtonRow>
        </>
      ) : !detail ? (
        <LoadingSpinner />
      ) : (
        <>
          <Facts
            items={[
              [
                "Applies to",
                `${PLAYBOOK_CODE_KIND_LABEL[detail.codeKind] ?? detail.codeKind} ${detail.code}`,
              ],
              ["MAC", detail.macName ?? "Any MAC"],
            ]}
          />
          <NoticeAlert message={notice} />
          <ErrorAlert message={error} />
          {can("playbook.author") && !draft ? (
            <ButtonRow>
              <Button
                tone="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setEditing({ kind: "version", playbookId, from: latest })}
              >
                New version
              </Button>
            </ButtonRow>
          ) : null}
          <ul aria-label="Versions">{detail.versions.map(versionRow)}</ul>
        </>
      )}
      {editing ? (
        <PlaybookEditor
          mode={editing}
          onClose={() => setEditing(null)}
          onDone={(message) => {
            setEditing(null);
            setNotice(message);
            void load();
            onChanged();
          }}
          onStale={(message) => {
            setEditing(null);
            setError(message);
            void load();
          }}
        />
      ) : null}
    </ActionRail>
  );
}
