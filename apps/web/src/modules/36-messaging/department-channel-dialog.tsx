// M36 WP 2.9 — create a department channel (an existing `location` or `discipline` channel kind). Only offered to a
// holder of messaging.announce; the server enforces it. The channel is found if it already exists, so creating twice
// opens the same conversation. Members are added afterwards from the channel's member list.
import { Button, LoadingSpinner, Modal, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { apiErrorMessage } from "./messaging-utils";
import "./announcements.css";

type DepartmentKind = "location" | "discipline";
interface Subject {
  id: string;
  name: string;
}

const KIND_LABEL: Record<DepartmentKind, string> = {
  location: "Location",
  discipline: "Discipline",
};
/** Roles that read as a clinical discipline; the server accepts any enabled role of the organization. */
const DISCIPLINE_CATEGORIES = new Set(["clinical_staff", "clinical_leadership"]);

export function DepartmentChannelDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Resolves false when the new channel could not be opened. */
  onCreated: (channelId: string) => Promise<boolean>;
}): JSX.Element {
  const client = useApiClient();
  const [kind, setKind] = useState<DepartmentKind>("location");
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [subjectId, setSubjectId] = useState("");
  const [title, setTitle] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (!open || retry < 0) return; // `retry` only re-runs this effect (Retry button)
    const attempt = ++sequence.current;
    setSubjects(null);
    setSubjectId("");
    setLoadError(null);
    const fail = (message?: unknown): void => {
      if (attempt !== sequence.current) return;
      setSubjects([]);
      setLoadError(apiErrorMessage(message, `Could not load ${KIND_LABEL[kind].toLowerCase()}s.`));
    };
    const load =
      kind === "location"
        ? client.GET("/api/v1/locations", { params: { query: { limit: 100 } } }).then((r) => ({
            error: r.error,
            rows: (r.data?.items ?? []).map((item) => ({ id: item.id, name: item.name })),
          }))
        : client.GET("/api/v1/roles").then((r) => ({
            error: r.error,
            rows: (r.data?.roles ?? [])
              .filter((role) => role.enabled && DISCIPLINE_CATEGORIES.has(role.category))
              .map((role) => ({ id: role.roleId, name: role.name })),
          }));
    void load
      .then(({ error, rows }) => {
        if (attempt !== sequence.current) return;
        if (error) return fail(error);
        setSubjects(rows);
        setSubjectId(rows[0]?.id ?? "");
      })
      .catch(() => fail());
    return () => {
      sequence.current += 1;
    };
  }, [client, kind, open, retry]);

  async function create(): Promise<void> {
    if (creatingRef.current || !subjectId) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const { data, error } = await client.POST("/api/v1/messaging/department-channels", {
        body: { kind, subjectId, ...(title.trim() ? { title: title.trim() } : {}) },
      });
      if (error || !data?.channelId) {
        setCreateError(
          apiErrorMessage(error, "The channel could not be created. Please try again."),
        );
        return;
      }
      if (!(await onCreated(data.channelId))) {
        setCreateError("The channel was created, but it could not be opened. Refresh Messaging.");
      }
    } catch {
      setCreateError("The channel could not be created. Please try again.");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={creating ? undefined : onClose}
      ariaLabel="New department channel"
      width="32rem"
    >
      <div className="wx-new-conversation">
        <header>
          <h2>New department channel</h2>
          <p>A shared channel for one location or discipline. Add its members once it is open.</p>
        </header>
        <div className="wx-department-form">
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add default border and padding to the existing toggle row */}
          <div role="group" aria-label="Department type" className="wx-conversation-type-tabs">
            {(["location", "discipline"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                disabled={creating}
                onClick={() => setKind(option)}
              >
                {KIND_LABEL[option]}
              </button>
            ))}
          </div>
          {subjects === null ? (
            <output className="wx-conversation-picker-state">
              <LoadingSpinner label={`Loading ${KIND_LABEL[kind].toLowerCase()}s`} />
            </output>
          ) : loadError ? (
            <div role="alert" className="wx-conversation-picker-state">
              <span>{loadError}</span>
              <Button size="sm" tone="secondary" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </Button>
            </div>
          ) : subjects.length === 0 ? (
            <p className="wx-announcement-empty">
              No {KIND_LABEL[kind].toLowerCase()}s are available.
            </p>
          ) : (
            <label>
              <span>{KIND_LABEL[kind]}</span>
              <select
                value={subjectId}
                disabled={creating}
                onChange={(event) => setSubjectId(event.target.value)}
              >
                {subjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Channel name (optional)</span>
            <input
              type="text"
              value={title}
              maxLength={120}
              disabled={creating}
              placeholder="Defaults to the name above"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        </div>
        {createError ? (
          <div role="alert" className="wx-messaging-error">
            {createError}
          </div>
        ) : null}
        <footer>
          <Button tone="secondary" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button
            onClick={() => void create()}
            disabled={!subjectId || creating}
            loading={creating}
          >
            {creating ? "Opening…" : "Open channel"}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
