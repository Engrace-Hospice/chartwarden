import { Button, CenteredCardLayout, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/02-identity — `app.<base>` landing (ADR-0049 Phase 4). A person who does not know their
// organization's address enters their email; the backend mails the sign-in link of each organization they belong to.
// Same no-enumeration rule as forgot-password.tsx: the confirmation is identical whatever the outcome (a miss, a
// rate limit, a network failure), so nothing here reveals whether an address belongs to an organization.
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { BrandLockup } from "./brand-lockup";

const MUTED = { margin: 0, color: "var(--color-on-surface-variant)" } as const;

export function AppLanding(): JSX.Element {
  const client = useApiClient();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);

  // The form is replaced by the confirmation: move focus to it so keyboard and screen-reader users land on the answer.
  useEffect(() => {
    if (sent) confirmationHeading.current?.focus();
  }, [sent]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await client.POST("/api/v1/public/find-my-organization", { body: { email: email.trim() } });
    } catch {
      // Deliberately swallowed: the answer shown must not depend on the outcome.
    }
    setBusy(false);
    setSent(true);
  }

  return (
    <CenteredCardLayout brand={<BrandLockup />}>
      {sent ? (
        // biome-ignore lint/a11y/useSemanticElements: <output> allows phrasing content only; this status holds flow content.
        <div role="status" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <h1 ref={confirmationHeading} tabIndex={-1} style={{ margin: 0, fontSize: "1.1rem" }}>
            Check your email
          </h1>
          <p style={{ ...MUTED, fontSize: "0.9rem" }}>
            If that address belongs to an organization, we’ve emailed sign-in links.
          </p>
        </div>
      ) : (
        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <h1 style={{ margin: 0, fontSize: "1.1rem" }}>Find your organization</h1>
          <p style={{ ...MUTED, fontSize: "0.85rem" }}>
            Enter your work email and we’ll send you the sign-in address of your organization.
          </p>
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
          />
          <Button type="submit" loading={busy} disabled={!email.trim()}>
            {busy ? "Sending…" : "Email me my sign-in links"}
          </Button>
        </form>
      )}
    </CenteredCardLayout>
  );
}
