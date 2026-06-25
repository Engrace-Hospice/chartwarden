import {
  EmptyState,
  FilterBar,
  Glyph,
  GuardChip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/34-saas — onboarding-template catalog (M34 SaaS Tenant Platform, R2 Phase-3).
// Route: /onboarding/templates. The platform-ops onboarding-step floor — the 11 canonical platform-seed
// templates plus tenant additions (SD-036 pattern-2). Backed by GET /api/v1/platform/onboarding-templates
// (cursor-paginated). canonical=true is migration-only: those rows are READ-ONLY here (the write route
// refuses isCanonical=true), so the editor surfaces a GuardChip on a canonical selection and an inline
// edit/add form for non-canonical ones, POSTing /api/v1/platform/onboarding-templates (step-up gated
// server-side). requiredPermission: `onboarding_template.list`. Mirrors the M40/M36 R1 exemplars.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { cap } from "./saas-status";

// The onboarding-template view (mirrors the backend OnboardingTemplateViewSchema).
interface OnboardingTemplate {
  id: string;
  key: string;
  title: string;
  canonicalOrder: number;
  isCanonical: boolean;
  createdAt: string;
}
interface TemplateListPage {
  items: OnboardingTemplate[];
  nextCursor: string | null;
  hasMore: boolean;
}

type OriginFilter = "" | "canonical" | "tenant";

export function OnboardingTemplates(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<OnboardingTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<OriginFilter>("");
  const [selected, setSelected] = useState<OnboardingTemplate | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/onboarding-templates", {
      params: { query: { limit: 100 } },
    } as never);
    if (err) {
      setError("Could not load onboarding templates.");
      setLoading(false);
      return;
    }
    setItems(((data as TemplateListPage | undefined)?.items ?? []) as OnboardingTemplate[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Sorted by the canonical step order (the data-driven onboarding floor), then filtered by origin.
  const visible = useMemo(() => {
    const sorted = [...items].sort((a, b) => a.canonicalOrder - b.canonicalOrder);
    if (origin === "canonical") return sorted.filter((t) => t.isCanonical);
    if (origin === "tenant") return sorted.filter((t) => !t.isCanonical);
    return sorted;
  }, [items, origin]);

  const onSelect = (t: OnboardingTemplate) => {
    setAdding(false);
    setSelected(t);
  };
  const onSaved = () => {
    setSelected(null);
    setAdding(false);
    void load();
  };

  return (
    <WorkQueueLayout
      header={<PageHeader title="Onboarding Templates" breadcrumb="Onboarding · Step catalog" />}
      filters={
        <FilterBar
          actions={
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setAdding(true);
              }}
            >
              Add template
            </button>
          }
        >
          <select
            aria-label="Filter by origin"
            value={origin}
            onChange={(e) => setOrigin(e.target.value as OriginFilter)}
          >
            <option value="">All templates</option>
            <option value="canonical">Canonical (platform)</option>
            <option value="tenant">Tenant additions</option>
          </select>
        </FilterBar>
      }
      table={
        <TemplateTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={onSelect}
        />
      }
      detail={
        adding ? (
          <TemplateEditor mode="add" onClose={() => setAdding(false)} onSaved={onSaved} />
        ) : selected ? (
          <TemplateEditor
            mode="edit"
            template={selected}
            onClose={() => setSelected(null)}
            onSaved={onSaved}
          />
        ) : undefined
      }
    />
  );
}

function TemplateTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: OnboardingTemplate[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (t: OnboardingTemplate) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return (
      <EmptyState title="No templates" description="No onboarding templates match this filter." />
    );
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Key</th>
            <th>Title</th>
            <th>Origin</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr
              key={t.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={t.id === selectedId}
              onClick={() => onSelect(t)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(t);
                }
              }}
              style={{
                cursor: "pointer",
                background: t.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td className="tabular-nums">{t.canonicalOrder}</td>
              <td className="wx-data-md">{t.key}</td>
              <td>{t.title}</td>
              <td>
                {t.isCanonical ? (
                  <StatusPill label="Canonical" tone="neutral" />
                ) : (
                  <StatusPill label="Tenant" tone="progress" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Inline add/edit form. Canonical templates are migration-only (the write route refuses isCanonical=true),
// so an edit on a canonical row is read-only and surfaces a GuardChip explaining why.
function TemplateEditor({
  mode,
  template,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  template?: OnboardingTemplate;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const readOnly = mode === "edit" && (template?.isCanonical ?? false);
  const [key, setKey] = useState(template?.key ?? "");
  const [title, setTitle] = useState(template?.title ?? "");
  const [order, setOrder] = useState<string>(template ? String(template.canonicalOrder) : "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSave =
    !readOnly && key.trim().length > 0 && title.trim().length > 0 && order.trim().length > 0;

  async function save(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    setSaveError(null);
    const { error: err } = await client.POST("/api/v1/platform/onboarding-templates", {
      body: {
        key: key.trim(),
        title: title.trim(),
        canonicalOrder: Number(order),
        isCanonical: false,
      },
    } as never);
    setSaving(false);
    if (err) {
      setSaveError("Could not save the template.");
      return;
    }
    onSaved();
  }

  const fieldStyle = {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.25rem",
    marginBottom: "0.75rem",
  };
  const labelStyle = { fontSize: "0.7rem", color: "var(--color-on-surface-variant)" };

  return (
    <RightDetailPanel
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          <Glyph name="check-circle" size={16} />
          {mode === "add" ? "New Template" : "Edit Template"}
        </span>
      }
      onClose={onClose}
    >
      {readOnly ? (
        <div style={{ marginBottom: "0.75rem" }}>
          <GuardChip reason="Canonical templates are platform-seed (migration-only) and cannot be edited." />
        </div>
      ) : null}

      <div style={fieldStyle}>
        <label htmlFor="tmpl-key" style={labelStyle}>
          Key
        </label>
        <input
          id="tmpl-key"
          className="wx-data-md"
          value={key}
          disabled={readOnly || mode === "edit"}
          onChange={(e) => setKey(e.target.value)}
          placeholder="e.g. baa_signed"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="tmpl-title" style={labelStyle}>
          Title
        </label>
        <input
          id="tmpl-title"
          value={title}
          disabled={readOnly}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Human-readable step title"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="tmpl-order" style={labelStyle}>
          Step order
        </label>
        <input
          id="tmpl-order"
          className="tabular-nums"
          type="number"
          min={0}
          max={1000}
          value={order}
          disabled={readOnly}
          onChange={(e) => setOrder(e.target.value)}
        />
      </div>

      {template ? (
        <div
          style={{
            fontSize: "0.7rem",
            color: "var(--color-on-surface-variant)",
            marginBottom: "0.75rem",
          }}
        >
          Template id <span className="wx-data-md">{template.id}</span>
        </div>
      ) : null}

      {saveError ? (
        <div style={{ color: "var(--color-error)", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
          {saveError}
        </div>
      ) : null}

      {!readOnly ? (
        <button type="button" disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? "Saving…" : mode === "add" ? "Add template" : "Save changes"}
        </button>
      ) : null}
    </RightDetailPanel>
  );
}
