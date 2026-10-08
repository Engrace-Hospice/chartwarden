import { Button, CenteredCardLayout, InlineAlert, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — Funeral home case (`/funeral/case`). The ONE screen a redeemed funeral-home session holds: the
// decedent's legal name and date of death, so the funeral home can confirm it is handling the right person. Nothing else
// is shown or readable — the server's session is pinned to one patient and every other route refuses it. If the session
// has ended (or never began) the page says so and offers nothing further.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { signOut } from "../auth-http";
import { day } from "./portal-format";

interface FuneralCase {
  decedentName: string;
  dateOfDeath: string;
}

type State = { kind: "loading" } | { kind: "ready"; found: FuneralCase } | { kind: "ended" };

export function PortalFuneralCase(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await client.GET("/api/v1/funeral/case", {});
      if (!active) return;
      setState(res.error || !res.data ? { kind: "ended" } : { kind: "ready", found: res.data });
    })();
    return () => {
      active = false;
    };
  }, [client]);

  async function finish(): Promise<void> {
    await signOut();
    setState({ kind: "ended" });
  }

  return (
    <CenteredCardLayout
      brand={
        <div style={{ fontFamily: t.fontDisplay, fontSize: "1.5rem", fontWeight: 600 }}>
          Funeral home access
        </div>
      }
    >
      {state.kind === "loading" ? (
        <output style={{ margin: 0 }}>Loading…</output>
      ) : state.kind === "ready" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          <h1 style={{ margin: 0, fontSize: "1.15rem" }}>{state.found.decedentName}</h1>
          <p style={{ margin: 0, color: t.onSurfaceVariant }}>
            Date of death: {day(state.found.dateOfDeath)}
          </p>
          <InlineAlert tone="info">
            This is all the information shared through this link. Your access ends automatically.
          </InlineAlert>
          <Button tone="secondary" onClick={() => void finish()}>
            Finish and close access
          </Button>
        </div>
      ) : (
        <InlineAlert tone="error">
          This access has ended. If you still need it, please ask the care team for a new link.
        </InlineAlert>
      )}
    </CenteredCardLayout>
  );
}
