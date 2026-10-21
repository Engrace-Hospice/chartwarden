// M36 WP 3.1 - the tiles of the patient context panel. A pure view of GET /messaging/patients/:id/context: the server
// decides which tiles the caller may see (a denied tile is simply absent here, never a blank card), a failing source shows
// "temporarily unavailable" rather than "none", and every tile says when it was read and links to the owning screen.
import { useApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface TileBase {
  link: string;
}
type Tile<T> =
  | (TileBase & { state: "ok"; as_of: string; data: T })
  | (TileBase & { state: "unavailable" });
interface PatientContext {
  tiles: {
    status?: Tile<{ status: string | null }>;
    care_team?: Tile<{ member_count: number }>;
    allergies?: Tile<{ entries: Array<{ allergen: string; severity: string | null }> }>;
    medications?: Tile<{ active_count: number }>;
    open_tasks?: Tile<{ count: number }>;
  };
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; ctx: PatientContext };

const asOfLabel = (iso: string): string => `As of ${new Date(iso).toLocaleString()}`;

function TileCard<T>({
  title,
  tile,
  linkLabel = "Open in chart",
  children,
}: {
  title: string;
  tile: Tile<T> | undefined;
  linkLabel?: string;
  children: (data: T) => JSX.Element;
}): JSX.Element | null {
  if (!tile) return null;
  return (
    <section className="wx-messaging-context-tile" aria-label={title}>
      <h3>{title}</h3>
      {tile.state === "ok" ? (
        <>
          {children(tile.data)}
          <small>{asOfLabel(tile.as_of)}</small>
        </>
      ) : (
        <p role="status">Temporarily unavailable. Open the chart for the current value.</p>
      )}
      {tile.link.startsWith("/") ? <Link to={tile.link}>{linkLabel}</Link> : null}
    </section>
  );
}

export function PatientContextTiles({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    let stale = false;
    setState({ kind: "loading" });
    client
      .GET("/api/v1/messaging/patients/{patientId}/context", { params: { path: { patientId } } })
      .then(({ data }) => {
        if (stale) return;
        setState(
          data ? { kind: "ready", ctx: data as unknown as PatientContext } : { kind: "error" },
        );
      })
      .catch(() => {
        if (!stale) setState({ kind: "error" });
      });
    return () => {
      stale = true;
    };
  }, [client, patientId]);

  if (state.kind === "loading") return <p role="status">Loading patient context…</p>;
  if (state.kind === "error") return <p role="alert">Patient context could not be loaded.</p>;
  const { tiles } = state.ctx;
  if (Object.keys(tiles).length === 0) return <p>No additional context available.</p>;
  return (
    <div className="wx-messaging-context-tiles">
      <TileCard title="Status" tile={tiles.status}>
        {(d) => <p>{d.status ? d.status.replaceAll("_", " ") : "Not recorded"}</p>}
      </TileCard>
      <TileCard title="Care team" tile={tiles.care_team}>
        {(d) => <p>{d.member_count} on the care team</p>}
      </TileCard>
      <TileCard title="Allergies" tile={tiles.allergies}>
        {(d) =>
          d.entries.length === 0 ? (
            <p>No allergies recorded</p>
          ) : (
            <ul>
              {d.entries.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no id and are never reordered client-side
                <li key={`${i}-${a.allergen}`}>
                  {a.allergen}
                  {a.severity && a.severity !== "unknown" ? ` (${a.severity})` : ""}
                </li>
              ))}
            </ul>
          )
        }
      </TileCard>
      <TileCard title="Medications" tile={tiles.medications}>
        {(d) => <p>{d.active_count} active medications</p>}
      </TileCard>
      <TileCard title="Your open tasks" tile={tiles.open_tasks} linkLabel="Open tasks">
        {(d) => <p>{d.count} open</p>}
      </TileCard>
    </div>
  );
}
