import { Button, LoadingSpinner, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Navigate } from "react-router-dom";

type State = "checking" | "allowed" | "required" | "unavailable";

/** UX guard for chromed routes; the backend credential-state gate remains authoritative. */
export function CredentialStateGuard({ children }: { children: ReactNode }): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    let current = true;
    void client
      .GET("/api/v1/auth/credential-status")
      .then(({ data, error }) => {
        if (!current) return;
        if (error || !data) setState("unavailable");
        else setState(data.passwordChangeRequired ? "required" : "allowed");
      })
      .catch(() => {
        if (current) setState("unavailable");
      });
    return () => {
      current = false;
    };
  }, [client]);

  if (state === "required") return <Navigate to="/login/change-password" replace />;
  if (state === "allowed") return <>{children}</>;
  if (state === "checking") return <LoadingSpinner label="Checking account security…" />;
  return (
    <div role="alert" style={{ padding: "2rem", maxWidth: "32rem", margin: "4rem auto" }}>
      <h1 style={{ fontSize: "1.2rem" }}>Account security unavailable</h1>
      <p style={{ color: "var(--color-on-surface-variant)" }}>
        ChartWarden could not verify whether your account setup is complete. Workspace access
        remains blocked for your protection.
      </p>
      <Button tone="primary" onClick={() => window.location.reload()}>
        Try again
      </Button>
    </div>
  );
}
