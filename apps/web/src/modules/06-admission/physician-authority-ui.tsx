// apps/web/src/modules/06-admission/physician-authority-ui.tsx — shared pieces for the 42 CFR 418.25(a)
// admission recommendation and the 42 CFR 418.26(b) discharge order (FY 2026 / FY 2027 hospice rules).
//
// The signer set is the same for both: the hospice medical director, the physician designee (§ 418.3), or
// the physician member of THIS patient's IDG — never the attending, an NP or a PA. The picker lists only
// the signers the server says are eligible for the admission's patient (`GET /admissions/:id/physician-
// signers`), each with the capacity it would be recorded under; the server re-validates on every write
// (ADR-0030 — no authorization on the frontend). Redesign kit only: kit fields/Button/StatusPill, flat
// sections, the right-rail drawer (`aside.wx-admission-drawer`) — mockup "Admissions" (03_20_25).
import {
  Glyph,
  type GlyphName,
  IconButton,
  SelectField,
  StatusPill,
  useApiClient,
  useDrawerA11y,
} from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

export type PhysicianSignerCapacity =
  | "medical_director"
  | "physician_designee"
  | "idg_physician_member";

export const CAPACITY_LABEL: Record<PhysicianSignerCapacity, string> = {
  medical_director: "Medical director",
  physician_designee: "Physician designee",
  idg_physician_member: "IDG physician member",
};

export interface PhysicianSignerCandidate {
  userId: string;
  name: string | null;
  capacities: PhysicianSignerCapacity[];
}

/** Loads the eligible signers for an admission's patient. `null` = could not be loaded. */
export function usePhysicianSigners(admissionId: string): {
  signers: PhysicianSignerCandidate[] | null;
  loading: boolean;
} {
  const client = useApiClient();
  const [state, setState] = useState<{
    signers: PhysicianSignerCandidate[] | null;
    loading: boolean;
  }>({ signers: null, loading: true });
  useEffect(() => {
    let active = true;
    client
      .GET("/api/v1/admissions/{id}/physician-signers", { params: { path: { id: admissionId } } })
      .then((r) => {
        if (!active) return;
        const items = (r.data as { items?: PhysicianSignerCandidate[] } | undefined)?.items;
        setState({ signers: r.error ? null : (items ?? []), loading: false });
      })
      .catch(() => active && setState({ signers: null, loading: false }));
    return () => {
      active = false;
    };
  }, [client, admissionId]);
  return state;
}

export const signerName = (c: Pick<PhysicianSignerCandidate, "name" | "userId">): string =>
  c.name ?? `Physician ${c.userId.slice(0, 8)}`;

/**
 * The signer picker: only eligible physicians, each labelled with the capacity they would sign in. A signer
 * holding several capacities is recorded under the first (medical director → designee → IDG physician).
 */
export function PhysicianSignerPicker({
  admissionId,
  label,
  value,
  onChange,
  error,
}: {
  admissionId: string;
  label: string;
  value: string;
  onChange: (userId: string, capacity: PhysicianSignerCapacity | null) => void;
  error?: string;
}): JSX.Element {
  const { signers, loading } = usePhysicianSigners(admissionId);
  const selected = signers?.find((s) => s.userId === value) ?? null;
  const hint = loading
    ? "Loading eligible physicians…"
    : signers === null
      ? "Eligible physicians could not be loaded."
      : signers.length === 0
        ? "No medical director, physician designee or IDG physician is set up for this patient."
        : "Medical director, physician designee, or this patient's IDG physician. Attendings, NPs and PAs can't sign.";
  return (
    <div className="wx-pa-stack">
      <SelectField
        label={label}
        required
        value={value}
        error={error}
        hint={hint}
        disabled={loading || !signers || signers.length === 0}
        onChange={(e) => {
          const pick = signers?.find((s) => s.userId === e.target.value) ?? null;
          onChange(e.target.value, pick?.capacities[0] ?? null);
        }}
        options={[
          { value: "", label: "Select a physician" },
          ...(signers ?? []).map((s) => ({
            value: s.userId,
            label: `${signerName(s)} — ${CAPACITY_LABEL[s.capacities[0] ?? "medical_director"]}`,
          })),
        ]}
      />
      {selected ? <CapacityPills capacities={selected.capacities} /> : null}
    </div>
  );
}

export function CapacityPills({
  capacities,
}: {
  capacities: readonly PhysicianSignerCapacity[];
}): JSX.Element {
  return (
    <div className="wx-pa-capacities">
      {capacities.map((c) => (
        <StatusPill key={c} label={CAPACITY_LABEL[c]} tone="progress" />
      ))}
    </div>
  );
}

/** Read-only label/value rows with a lock + source line (who recorded it, under which rule). */
export function LockedFacts({
  rows,
  source,
}: {
  rows: readonly (readonly [string, ReactNode])[];
  source: ReactNode;
}): JSX.Element {
  return (
    <div className="wx-pa-stack">
      <dl className="wx-kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="wx-pa-source">
        <Glyph name="lock" size={12} />
        <span>{source}</span>
      </p>
    </div>
  );
}

/** A flat section (icon, title, subtitle, right-side tags) — the redesign's clinical section shell. */
export function AuthoritySection({
  id,
  icon,
  title,
  description,
  aside,
  children,
}: {
  id?: string;
  icon: GlyphName;
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className="wx-clinical-section">
      <header>
        <span className="wx-clinical-section-icon" aria-hidden>
          <Glyph name={icon} size={22} strokeWidth={1.6} />
        </span>
        <div className="wx-pa-head-text">
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {aside ? <div className="wx-pa-section-aside">{aside}</div> : null}
      </header>
      <div className="wx-clinical-section-body">{children}</div>
    </section>
  );
}

/** The right-rail drawer shell (icon tile, title, subtitle, close) the admission census uses. */
export function AuthorityDrawer({
  icon,
  title,
  subtitle,
  onClose,
  children,
}: {
  icon: GlyphName;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={title}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon wx-pa-head-icon" aria-hidden>
          <Glyph name={icon} size={16} />
        </span>
        <div className="wx-pa-head-text">
          <h2>{title}</h2>
          <div className="wx-row-sub">{subtitle}</div>
        </div>
        <IconButton tone="tertiary" size="sm" aria-label="Close panel" onClick={onClose}>
          <Glyph name="close" size={16} />
        </IconButton>
      </header>
      <div className="wx-action-body">{children}</div>
    </aside>
  );
}

/** "2026-10-06T14:05" for a datetime-local field, from now. */
export function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value → ISO instant (`""` stays `""`). */
export function localInputToIso(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function usDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** The server's error envelope message, or a fallback. */
export function errorText(error: unknown, fallback: string): string {
  const e = error as { error?: { message?: string; code?: string } } | undefined;
  return e?.error?.message ?? fallback;
}
