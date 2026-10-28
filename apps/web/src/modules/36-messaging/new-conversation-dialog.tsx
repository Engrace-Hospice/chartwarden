import { formatMrn } from "@chartwarden/types";
import { Button, EmptyState, LoadingSpinner, Modal, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { ConversationType, DmStaffMember, PatientSearchResult } from "./messaging-types";
import { apiErrorMessage, initialsOf } from "./messaging-utils";

export interface NewConversationDialogProps {
  open: boolean;
  organizationId: string;
  organizationName: string;
  currentUserId: string;
  onClose: () => void;
  onCreated: (channelId: string) => Promise<boolean>;
}

export function NewConversationDialog({
  open,
  organizationId,
  organizationName,
  currentUserId,
  onClose,
  onCreated,
}: NewConversationDialogProps): JSX.Element {
  const client = useApiClient();
  const [type, setType] = useState<ConversationType>("direct");
  const [query, setQuery] = useState("");
  const [staff, setStaff] = useState<DmStaffMember[] | null>(null);
  const [patients, setPatients] = useState<PatientSearchResult[] | null>(null);
  const [selectedStaff, setSelectedStaff] = useState<DmStaffMember | null>(null);
  const [groupMembers, setGroupMembers] = useState<DmStaffMember[]>([]);
  const [groupTitle, setGroupTitle] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<PatientSearchResult | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestSequence = useRef(0);
  const creatingRequest = useRef(false);

  useEffect(
    () => () => {
      requestSequence.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!open || !organizationId) return;
    const attempt = retry;
    const sequence = ++requestSequence.current;
    setStaff(null);
    setPatients(null);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      if (type !== "patient") {
        void client
          .GET("/api/v1/messaging/dm/staff", {
            params: { query: { q: query.trim() || undefined } },
          })
          .then(({ data, error }) => {
            if (sequence !== requestSequence.current || attempt !== retry) return;
            if (error) {
              setStaff([]);
              setSearchError(
                apiErrorMessage(error, "Could not search staff in this organization."),
              );
              return;
            }
            const eligible = ((data?.staff ?? []) as DmStaffMember[]).filter(
              (person) => person.userId !== currentUserId,
            );
            setStaff(eligible);
            setSelectedStaff((current) =>
              current && eligible.some((person) => person.userId === current.userId)
                ? current
                : null,
            );
          });
        return;
      }
      void client
        .GET("/api/v1/patients/messaging-search", {
          params: { query: { q: query.trim() || undefined, limit: 25 } },
        })
        .then(({ data, error }) => {
          if (sequence !== requestSequence.current || attempt !== retry) return;
          if (error) {
            setPatients([]);
            setSearchError(
              apiErrorMessage(error, "Could not search authorized patients in this organization."),
            );
            return;
          }
          const results = (data?.patients ?? []) as PatientSearchResult[];
          setPatients(results);
          setSelectedPatient((current) =>
            current && results.some((patient) => patient.patientId === current.patientId)
              ? current
              : null,
          );
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [client, currentUserId, open, organizationId, query, retry, type]);

  function changeType(next: ConversationType): void {
    requestSequence.current += 1;
    setType(next);
    setQuery("");
    setStaff(null);
    setPatients(null);
    setSelectedStaff(null);
    setGroupMembers([]);
    setGroupTitle("");
    setSelectedPatient(null);
    setHighlightedIndex(0);
    setSearchError(null);
    setCreateError(null);
  }

  async function createConversation(): Promise<void> {
    if (
      creatingRequest.current ||
      (type === "direct"
        ? !selectedStaff
        : type === "group"
          ? groupMembers.length < 2 || groupMembers.length > 49 || !groupTitle.trim()
          : !selectedPatient)
    )
      return;
    creatingRequest.current = true;
    setCreating(true);
    setCreateError(null);
    const sequence = requestSequence.current;
    const result = await (type === "direct"
      ? client.POST("/api/v1/messaging/dm", { body: { userId: selectedStaff!.userId } })
      : type === "group"
        ? client.POST("/api/v1/messaging/groups", {
            body: {
              title: groupTitle.trim(),
              userIds: groupMembers.map((member) => member.userId),
            },
          })
        : client.POST("/api/v1/messaging/patients/{patientId}/care-team-channel", {
            params: { path: { patientId: selectedPatient!.patientId } },
          })
    ).catch(() => null);
    if (!result) {
      setCreateError("Could not start this conversation. Please try again.");
      creatingRequest.current = false;
      setCreating(false);
      return;
    }
    if (sequence !== requestSequence.current) {
      creatingRequest.current = false;
      setCreating(false);
      return;
    }
    creatingRequest.current = false;
    setCreating(false);
    if (result.error || !result.data?.channelId) {
      setCreateError(
        apiErrorMessage(
          result.error,
          type === "patient"
            ? "Your access to this patient may have changed. The conversation could not be opened."
            : "Could not start this conversation. Please try again.",
        ),
      );
      return;
    }
    if (!(await onCreated(result.data.channelId))) {
      setCreateError(
        "The conversation was created, but it could not be opened. Refresh Messaging and try again.",
      );
    }
  }

  const results = type !== "patient" ? (staff ?? []) : (patients ?? []);
  const loading = type !== "patient" ? staff === null : patients === null;
  const selected =
    type === "direct"
      ? selectedStaff
      : type === "group"
        ? groupMembers.length >= 2 && Boolean(groupTitle.trim())
        : selectedPatient;

  function chooseStaff(person: DmStaffMember): void {
    if (type === "group") {
      setGroupMembers((current) =>
        current.some((member) => member.userId === person.userId)
          ? current.filter((member) => member.userId !== person.userId)
          : current.length < 49
            ? [...current, person]
            : current,
      );
    } else setSelectedStaff(person);
  }

  function handleSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedIndex((index) => (index + delta + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = results[highlightedIndex];
      if (type !== "patient") chooseStaff(item as DmStaffMember);
      else setSelectedPatient(item as PatientSearchResult);
    }
  }

  return (
    <Modal
      open={open}
      onClose={creating ? undefined : onClose}
      ariaLabel="New conversation"
      width="36rem"
    >
      <div className="wx-new-conversation">
        <header>
          <h2>New conversation</h2>
          <p>
            Start a secure conversation in <strong>{organizationName}</strong>.
          </p>
        </header>
        <div role="tablist" aria-label="Conversation type" className="wx-conversation-type-tabs">
          {(["direct", "group", "patient"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={type === option}
              disabled={creating}
              onClick={() => changeType(option)}
            >
              {option === "direct"
                ? "Direct message"
                : option === "group"
                  ? "Group"
                  : "Patient care team"}
            </button>
          ))}
        </div>
        <label className="wx-conversation-picker-search">
          <span>
            {type === "patient" ? "Patient" : type === "group" ? "Add colleagues" : "Staff member"}
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedStaff(null);
              setSelectedPatient(null);
              setHighlightedIndex(0);
            }}
            onKeyDown={handleSearchKey}
            placeholder={type === "patient" ? "Search by name or MRN…" : "Search by name or email…"}
            aria-label={type === "patient" ? "Search authorized patients" : "Search eligible staff"}
            aria-controls="new-conversation-results"
            aria-activedescendant={
              results[highlightedIndex]
                ? `conversation-result-${
                    type !== "patient"
                      ? (results[highlightedIndex] as DmStaffMember).userId
                      : (results[highlightedIndex] as PatientSearchResult).patientId
                  }`
                : undefined
            }
          />
        </label>
        {type === "group" ? (
          <div className="wx-group-setup">
            <label>
              Group name
              <input
                value={groupTitle}
                maxLength={80}
                onChange={(event) => setGroupTitle(event.target.value)}
                placeholder="e.g. Weekend care coordination"
              />
            </label>
            <p>{groupMembers.length} colleagues selected · choose at least 2</p>
            <div className="wx-group-selected" aria-label="Selected colleagues">
              {groupMembers.map((person) => (
                <button
                  type="button"
                  key={person.userId}
                  onClick={() => chooseStaff(person)}
                  aria-label={`Remove ${person.displayName}`}
                >
                  {person.displayName} ×
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div id="new-conversation-results" className="wx-conversation-picker-results">
          {loading ? (
            <output className="wx-conversation-picker-state">
              <LoadingSpinner label="Searching" />
            </output>
          ) : searchError ? (
            <div role="alert" className="wx-conversation-picker-state">
              <span>{searchError}</span>
              <Button size="sm" tone="secondary" onClick={() => setRetry((value) => value + 1)}>
                Retry
              </Button>
            </div>
          ) : results.length === 0 ? (
            <EmptyState
              title={
                type === "patient" ? "No authorized patients found" : "No eligible staff found"
              }
              description="Try a different search."
            />
          ) : (
            <ul aria-label={type === "patient" ? "Authorized patients" : "Eligible staff"}>
              {results.map((item, index) => {
                const isStaff = type !== "patient";
                const id = isStaff
                  ? (item as DmStaffMember).userId
                  : (item as PatientSearchResult).patientId;
                const label = isStaff
                  ? (item as DmStaffMember).displayName
                  : (item as PatientSearchResult).displayName;
                const detail = isStaff
                  ? (item as DmStaffMember).roles.join(" · ") || "Staff member"
                  : formatMrn((item as PatientSearchResult).medicalRecordNumber);
                const isSelected = isStaff
                  ? type === "group"
                    ? groupMembers.some((member) => member.userId === id)
                    : selectedStaff?.userId === id
                  : selectedPatient?.patientId === id;
                return (
                  <li key={id}>
                    <button
                      id={`conversation-result-${id}`}
                      type="button"
                      className={isSelected || highlightedIndex === index ? "is-active" : undefined}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() =>
                        isStaff
                          ? chooseStaff(item as DmStaffMember)
                          : setSelectedPatient(item as PatientSearchResult)
                      }
                    >
                      <span className="wx-messaging-avatar" aria-hidden="true">
                        {initialsOf(label)}
                      </span>
                      <span>
                        <strong>{label}</strong>
                        <small>{detail}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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
            onClick={() => void createConversation()}
            disabled={!selected || creating}
            loading={creating}
          >
            {creating ? "Opening…" : type === "group" ? "Create group" : "Open conversation"}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
