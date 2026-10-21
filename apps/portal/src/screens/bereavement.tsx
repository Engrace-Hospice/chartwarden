import { Button, Glyph, useApiClient } from "@chartwarden/ui";
// M31 bereavement support: M16 owns the program and resource content. M31 renders only the
// authorized projection and the existing opt-out operation. Do not invent outreach or services.
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { usePortalPatient } from "../patient-context";
import { humanize, readError } from "./portal-format";
import { PortalPage } from "./portal-page";

interface Resource {
  title?: string;
  summary?: string;
  kind?: string;
  url?: string;
}
interface ProgramItem {
  label?: string;
  detail?: string;
}
type ResourceState<T> =
  | { status: "loading"; items: [] }
  | { status: "error"; items: []; message: string }
  | { status: "ready"; items: T[] };
function parseItems<T>(value: unknown, fields: readonly string[]): T[] | null {
  if (!value || typeof value !== "object" || !("items" in value)) return null;
  const items = (value as { items: unknown }).items;
  if (
    !Array.isArray(items) ||
    items.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const entry = item as Record<string, unknown>;
      return fields.some(
        (field) => entry[field] != null && typeof entry[field] !== "string",
      );
    })
  )
    return null;
  return items as T[];
}

/** Only explicitly secure external resource URLs can leave this patient-facing portal. */
function safeResourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function SectionLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="wx-bereavement-skeleton" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}
function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="wx-bereavement-section-state" role="alert">
      <Glyph name="alert-circle" size={22} aria-hidden="true" />
      <div>
        <strong>Information unavailable</strong>
        <p>{message}</p>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/** Key the complete screen by selected patient; never reuse grief-support content across records. */
export function PortalBereavement(): JSX.Element {
  const { patientId } = usePortalPatient();
  return (
    <BereavementForPatient
      key={patientId ?? "no-patient"}
      patientId={patientId}
    />
  );
}

function BereavementForPatient({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const [program, setProgram] = useState<ResourceState<ProgramItem>>({
    status: "loading",
    items: [],
  });
  const [resources, setResources] = useState<ResourceState<Resource>>({
    status: "loading",
    items: [],
  });
  const [programAttempt, setProgramAttempt] = useState(0);
  const [resourcesAttempt, setResourcesAttempt] = useState(0);
  const [confirmOptOut, setConfirmOptOut] = useState(false);
  const [optedOut, setOptedOut] = useState(false);
  const [optingOut, setOptingOut] = useState(false);
  const [optOutError, setOptOutError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setProgram({ status: "loading", items: [] });
    if (!patientId)
      return () => {
        active = false;
      };
    void (async () => {
      try {
        const response = await client.GET(
          "/api/v1/portal/bereavement/program",
          {},
        );
        if (!active) return;
        if ("error" in response) {
          setProgram({
            status: "error",
            items: [],
            message: readError(response.response?.status),
          });
          return;
        }
        const items = parseItems<ProgramItem>(response.data, [
          "label",
          "detail",
        ]);
        setProgram(
          items
            ? { status: "ready", items }
            : { status: "error", items: [], message: readError(undefined) },
        );
      } catch {
        if (active)
          setProgram({
            status: "error",
            items: [],
            message: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, programAttempt]);

  useEffect(() => {
    let active = true;
    setResources({ status: "loading", items: [] });
    if (!patientId)
      return () => {
        active = false;
      };
    void (async () => {
      try {
        const response = await client.GET(
          "/api/v1/portal/bereavement/resources",
          {},
        );
        if (!active) return;
        if ("error" in response) {
          setResources({
            status: "error",
            items: [],
            message: readError(response.response?.status),
          });
          return;
        }
        const items = parseItems<Resource>(response.data, [
          "title",
          "summary",
          "kind",
          "url",
        ]);
        setResources(
          items
            ? { status: "ready", items }
            : { status: "error", items: [], message: readError(undefined) },
        );
      } catch {
        if (active)
          setResources({
            status: "error",
            items: [],
            message: readError(undefined),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, resourcesAttempt]);

  async function optOut(): Promise<void> {
    if (
      !patientId ||
      program.status !== "ready" ||
      !confirmOptOut ||
      requestInFlight.current ||
      optedOut
    )
      return;
    requestInFlight.current = true;
    setOptingOut(true);
    setOptOutError(null);
    try {
      const response = await client.POST(
        "/api/v1/portal/bereavement/opt-out",
        {},
      );
      if (!mounted.current) return;
      if ("error" in response) {
        setOptOutError(readError(response.response?.status));
        return;
      }
      setOptedOut(true);
      setConfirmOptOut(false);
    } catch {
      if (mounted.current)
        setOptOutError(
          "We couldn't confirm your preference. Please check with your hospice team before trying again.",
        );
    } finally {
      requestInFlight.current = false;
      if (mounted.current) setOptingOut(false);
    }
  }

  return (
    <PortalPage
      width="workspace"
      title="Bereavement support"
      subtitle="Information and support made available by your hospice team."
    >
      <div className="wx-bereavement-intro">
        <span className="wx-bereavement-intro__icon" aria-hidden="true">
          <Glyph name="heart" size={27} />
        </span>
        <div>
          <span className="wx-bereavement-eyebrow">Care and support</span>
          <h2>Support, at your own pace</h2>
          <p>
            Everyone experiences grief differently. You can explore information
            shared by your hospice team whenever you feel ready.
          </p>
        </div>
      </div>
      {!patientId ? (
        <div className="wx-bereavement-panel wx-bereavement-section-state">
          <p>
            Choose a patient to see the support information available to your
            account.
          </p>
        </div>
      ) : (
        <div className="wx-bereavement-layout">
          <div className="wx-bereavement-main">
            <section
              className="wx-bereavement-panel"
              aria-labelledby="bereavement-program-heading"
            >
              <div className="wx-bereavement-panel__heading">
                <span className="wx-bereavement-panel__icon" aria-hidden="true">
                  <Glyph name="heart" size={21} />
                </span>
                <div>
                  <h2 id="bereavement-program-heading">Your support program</h2>
                  <p>Program information shared by your hospice team.</p>
                </div>
              </div>
              {program.status === "loading" ? (
                <SectionLoading label="Loading support program" />
              ) : program.status === "error" ? (
                <SectionError
                  message={program.message}
                  onRetry={() => setProgramAttempt((v) => v + 1)}
                />
              ) : program.items.length ? (
                <ul className="wx-bereavement-program">
                  {program.items.map((item, index) => (
                    <li key={`${item.label ?? "program"}-${index}`}>
                      <span
                        className="wx-bereavement-program__mark"
                        aria-hidden="true"
                      >
                        <Glyph name="check-circle" size={18} />
                      </span>
                      <div>
                        <h3>{item.label?.trim() || "Support information"}</h3>
                        {item.detail?.trim() ? <p>{item.detail}</p> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="wx-bereavement-empty">
                  <Glyph name="heart" size={24} aria-hidden="true" />
                  <strong>No program details shared yet</strong>
                  <p>
                    When the hospice team shares program information for your
                    account, it will appear here.
                  </p>
                </div>
              )}
            </section>
            <section
              className="wx-bereavement-panel"
              aria-labelledby="bereavement-resources-heading"
            >
              <div className="wx-bereavement-panel__heading">
                <span className="wx-bereavement-panel__icon" aria-hidden="true">
                  <Glyph name="file-text" size={21} />
                </span>
                <div>
                  <h2 id="bereavement-resources-heading">Helpful resources</h2>
                  <p>Materials selected by your hospice team.</p>
                </div>
              </div>
              {resources.status === "loading" ? (
                <SectionLoading label="Loading support resources" />
              ) : resources.status === "error" ? (
                <SectionError
                  message={resources.message}
                  onRetry={() => setResourcesAttempt((v) => v + 1)}
                />
              ) : resources.items.length ? (
                <ul className="wx-bereavement-resources">
                  {resources.items.map((item, index) => {
                    const url = safeResourceUrl(item.url);
                    const title = item.title?.trim() || "Support resource";
                    return (
                      <li
                        key={`${title}-${index}`}
                        className="wx-bereavement-resource"
                      >
                        <div className="wx-bereavement-resource__body">
                          {item.kind ? (
                            <span className="wx-bereavement-eyebrow">
                              {humanize(item.kind)}
                            </span>
                          ) : null}
                          <h3>{title}</h3>
                          {item.summary?.trim() ? <p>{item.summary}</p> : null}
                        </div>
                        {url ? (
                          <a
                            className="wx-bereavement-resource__link"
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${title} in a new tab`}
                          >
                            Open resource{" "}
                            <Glyph
                              name="arrow-right"
                              size={16}
                              aria-hidden="true"
                            />
                          </a>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="wx-bereavement-empty">
                  <Glyph name="file-text" size={24} aria-hidden="true" />
                  <strong>No resources shared yet</strong>
                  <p>Resources shared with your account will appear here.</p>
                </div>
              )}
            </section>
          </div>
          <aside
            className="wx-bereavement-panel wx-bereavement-preferences"
            aria-labelledby="bereavement-outreach-heading"
          >
            <span className="wx-bereavement-panel__icon" aria-hidden="true">
              <Glyph name="message-square" size={22} />
            </span>
            <h2 id="bereavement-outreach-heading">Outreach preferences</h2>
            {program.status === "loading" ? (
              <p>Loading your support access…</p>
            ) : program.status === "error" ? (
              <p>
                Outreach preferences are unavailable until your support access
                can be confirmed.
              </p>
            ) : optedOut ? (
              <div className="wx-bereavement-opted-out" role="status">
                <Glyph name="check-circle" size={20} aria-hidden="true" />
                <div>
                  <strong>Preference submitted</strong>
                  <p>
                    You have opted out of bereavement outreach. Contact your
                    hospice team if you would like to discuss future support.
                  </p>
                </div>
              </div>
            ) : confirmOptOut ? (
              <div className="wx-bereavement-confirm">
                <p>
                  Please confirm that you do not want to receive future
                  bereavement outreach from your hospice team.
                </p>
                <div className="wx-bereavement-confirm__actions">
                  <Button
                    tone="secondary"
                    disabled={optingOut}
                    onClick={() => {
                      setConfirmOptOut(false);
                      setOptOutError(null);
                    }}
                  >
                    Keep outreach
                  </Button>
                  <Button
                    tone="secondary"
                    loading={optingOut}
                    disabled={optingOut}
                    onClick={() => void optOut()}
                  >
                    Confirm opt out
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p>
                  You can choose not to receive bereavement outreach. This will
                  not change information already made available here.
                </p>
                <Button
                  tone="secondary"
                  onClick={() => {
                    setConfirmOptOut(true);
                    setOptOutError(null);
                  }}
                >
                  Opt out of outreach
                </Button>
              </>
            )}
            {optOutError ? (
              <div className="wx-bereavement-opt-error" role="alert">
                {optOutError}
              </div>
            ) : null}
            <p className="wx-bereavement-preferences__note">
              If you have questions or need help, contact your hospice team
              through your usual contact method.
            </p>
          </aside>
        </div>
      )}
    </PortalPage>
  );
}
