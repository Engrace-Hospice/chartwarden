import type { PasskeyInfo } from "@wardenx/auth/client";
import { EmptyState, LoadingSpinner, PageHeader } from "@wardenx/ui";
// apps/web/src/modules/02-identity — Passkey enrollment & management (M2 Auth, ADR-0034 follow-up).
// Spec: docs/design/screens/core/WARDENX_UI_AUTH.md "passkey enrollment". An authenticated user registers a
// WebAuthn passkey (authClient.passkey.addPasskey) and lists/removes them. The WebAuthn ceremony is
// browser-only (a real authenticator) — not CI-testable — so this is build-/e2e-verified.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { authClient } from "./auth-client";

export function SecurityPasskeys(): JSX.Element {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    const { data, error: err } = await authClient.passkey.listUserPasskeys();
    if (err) {
      setError("Could not load your passkeys.");
      // `passkeys === null` is the "still loading" state (drives the spinner below) — leaving it
      // null on a load error kept the spinner spinning forever alongside the error message instead
      // of settling into the empty state.
      setPasskeys([]);
      return;
    }
    setPasskeys(data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function register(): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.passkey.addPasskey(
      name.trim() ? { name: name.trim() } : undefined,
    );
    setBusy(false);
    if (err) {
      setError("Passkey registration failed or was cancelled.");
      return;
    }
    setName("");
    void load();
  }

  async function remove(id: string): Promise<void> {
    const { error: err } = await authClient.passkey.deletePasskey({ id });
    if (err) {
      setError("Could not remove that passkey.");
      return;
    }
    void load();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <PageHeader title="Passkeys" />
      <div
        style={{
          padding: "1.5rem",
          maxWidth: "40rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.9rem" }}>
          Passkeys let you sign in with your device’s biometrics or security key instead of a
          password.
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            aria-label="Passkey name"
            placeholder="Name (e.g. iPhone Face ID)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              flex: 1,
              padding: "0.5rem 0.625rem",
              border: "1px solid var(--color-outline-variant)",
              borderRadius: "0.5rem",
            }}
          />
          <button type="button" onClick={register} disabled={busy} style={primaryBtn}>
            {busy ? "Registering…" : "Register a passkey"}
          </button>
        </div>
        {error ? (
          <p style={{ color: "var(--color-error)", margin: 0, fontSize: "0.85rem" }}>{error}</p>
        ) : null}
        {passkeys === null ? (
          <LoadingSpinner />
        ) : passkeys.length === 0 ? (
          <EmptyState
            title="No passkeys"
            description="Register one above to sign in without a password."
          />
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {passkeys.map((p) => (
              <li
                key={p.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.625rem 0.75rem",
                  border: "1px solid var(--color-outline-variant)",
                  borderRadius: "0.5rem",
                  background: "var(--color-surface-lowest)",
                }}
              >
                <span>
                  <strong>{p.name ?? "Passkey"}</strong>
                  {p.deviceType ? (
                    <span
                      style={{
                        marginLeft: "0.5rem",
                        fontSize: "0.75rem",
                        color: "var(--color-on-surface-variant)",
                      }}
                    >
                      {p.deviceType}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  style={{
                    cursor: "pointer",
                    color: "var(--color-error)",
                    background: "none",
                    border: "none",
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const primaryBtn = {
  padding: "0.5rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "var(--color-primary)",
  color: "var(--color-surface-lowest)",
  cursor: "pointer",
  fontWeight: 600,
  whiteSpace: "nowrap" as const,
} as const;
