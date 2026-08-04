import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/35-subscription — M35 promo codes (§5.1 `/billing/promos`).
// Apply a publicly-visible promo code to the subscription (POST /api/v1/subscription/apply_promo) and
// see the current plan context (GET /api/v1/subscription). The apply is a mutating action the server
// gates + idempotency-keys (§4.17); this surface presents the entry + surfaces the server's outcome
// (success or the plain 4xx reason — no client-side authz). The read DTO does not return the list of
// already-applied promos, so that is stated honestly rather than faked. Lantern: Detail pattern.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { cap, subscriptionTone } from "./billing-status";

interface Subscription {
  planName: string;
  status: string;
}

export function Promos(): JSX.Element {
  const client = useApiClient();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/subscription");
    if (res.error) {
      setError("Subscription unavailable.");
      setLoading(false);
      return;
    }
    setSub(res.data as unknown as Subscription);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(async () => {
    const promoCode = code.trim();
    if (!promoCode) return;
    setApplying(true);
    setOutcome(null);
    const res = await client.POST("/api/v1/subscription/apply_promo", {
      body: { promoCode },
    });
    if (res.error) {
      setOutcome({ ok: false, message: "That promo code could not be applied." });
    } else {
      setOutcome({ ok: true, message: `Promo code "${promoCode}" applied.` });
      setCode("");
    }
    setApplying(false);
  }, [client, code]);

  if (loading) return <LoadingSpinner />;
  if (error || !sub)
    return <EmptyState title="Unavailable" description={error ?? "No subscription."} />;

  return (
    <DetailPageLayout
      header={<PageHeader title="Promo codes" breadcrumb="Billing" />}
      aside={
        <div
          style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
          <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
            Current plan
          </span>
          <span style={{ fontWeight: 600 }}>{sub.planName}</span>
          <StatusPill label={cap(sub.status)} tone={subscriptionTone(sub.status)} />
        </div>
      }
    >
      <section
        style={{ maxWidth: "28rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <label htmlFor="promo-code" style={{ fontSize: "0.85rem", fontWeight: 500 }}>
          Apply a promo code
        </label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id="promo-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. LAUNCH25"
            style={{
              flex: 1,
              padding: "0.55rem 0.75rem",
              borderRadius: "var(--radius-md, 0.5rem)",
              border: "1px solid var(--color-outline)",
              background: "var(--color-surface-lowest)",
              color: "var(--color-on-surface)",
              fontSize: "0.9rem",
            }}
          />
          <button
            type="button"
            onClick={() => void apply()}
            disabled={applying || code.trim().length === 0}
            style={{
              padding: "0.55rem 1.1rem",
              borderRadius: "var(--radius-md, 0.5rem)",
              border: "none",
              background: "var(--color-primary)",
              color: "var(--color-on-primary)",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: applying || code.trim().length === 0 ? "default" : "pointer",
              opacity: applying || code.trim().length === 0 ? 0.6 : 1,
            }}
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        </div>
        {outcome ? (
          <div role="status" aria-live="polite">
            <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
          </div>
        ) : null}
        <p
          style={{
            fontSize: "0.8rem",
            color: "var(--color-on-surface-variant)",
            marginTop: "0.5rem",
          }}
        >
          Applied promotions are reflected on your next invoice. The subscription summary does not
          list previously-applied codes here — see your invoices for the discount lines.
        </p>
      </section>
    </DetailPageLayout>
  );
}
