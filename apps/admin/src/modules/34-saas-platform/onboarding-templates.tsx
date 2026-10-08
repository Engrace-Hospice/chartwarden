import {
  Button,
  Glyph,
  GuardChip,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  TextField,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
  useStaleSelection,
} from "@wardenx/ui";
// apps/admin/src/modules/34-saas-platform — onboarding-template catalog (M34 SaaS Tenant Platform, R2 Phase-3).
// Route: /onboarding/templates. The platform-ops onboarding-step floor — the 11 canonical platform-seed
// templates plus tenant additions (SD-036 pattern-2). Backed by GET /api/v1/platform/onboarding-templates
// (cursor-paginated). canonical=true is migration-only: those rows are READ-ONLY here (the write route
// refuses isCanonical=true), so the editor surfaces a GuardChip on a canonical selection and an inline
// edit/add form for non-canonical ones in the right drawer (`?template=<id>` or `?template=new`), POSTing /api/v1/platform/onboarding-templates (step-up gated
// server-side). requiredPermission: `onboarding_template.list`. Mirrors the M40/M36 R1 exemplars.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";

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

const LIST_LIMIT = 100;
const ORDER_MIN = 0;
const ORDER_MAX = 1000;
const NEW_TEMPLATE = "new";

export function OnboardingTemplates(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const drawerParam = params.get("template");
  const [items, setItems] = useState<OnboardingTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const guard = useRequestGuard();
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<OriginFilter>("");

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/onboarding-templates", {
      params: { query: { limit: LIST_LIMIT } },
    });
    if (!isCurrent()) return;
    if (err) {
      setError("Could not load onboarding templates.");
      setLoaded(false);
      setLoading(false);
      return;
    }
    setItems(((data as TemplateListPage | undefined)?.items ?? []) as OnboardingTemplate[]);
    setLoaded(true);
    setLoading(false);
  }, [client, guard]);

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

  const adding = drawerParam === NEW_TEMPLATE;
  const selected = drawerParam && !adding ? items.find((t) => t.id === drawerParam) : undefined;
  useStaleSelection({
    param: "template",
    ready: loaded,
    found: selected !== undefined,
    ignore: [NEW_TEMPLATE],
  });
  const closeDrawer = (): void => setParams({});
  const onSaved = () => {
    closeDrawer();
    void load();
  };

  return (
    <div className={`wx-list-drawer${adding || selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Onboarding templates</h1>
            <p>The onboarding step catalog: the canonical platform steps plus tenant additions.</p>
          </div>
          <div className="wx-list-toolbar-end">
            <select
              aria-label="Filter by origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value as OriginFilter)}
            >
              <option value="">All templates</option>
              <option value="canonical">Canonical (platform)</option>
              <option value="tenant">Tenant additions</option>
            </select>
            <Button onClick={() => setParams({ template: NEW_TEMPLATE })}>Add template</Button>
          </div>
        </header>

        <TemplateTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={(t) => setParams({ template: t.id })}
          onRetry={() => void load()}
        />
      </div>
      {adding ? (
        <TemplateEditor key={NEW_TEMPLATE} mode="add" onClose={closeDrawer} onSaved={onSaved} />
      ) : selected ? (
        <TemplateEditor
          key={selected.id}
          mode="edit"
          template={selected}
          onClose={closeDrawer}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

function TemplateTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: OnboardingTemplate[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (t: OnboardingTemplate) => void;
  onRetry: () => void;
}): JSX.Element {
  if (error)
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">{error}</InlineAlert>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading onboarding templates…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="clipboard-list" size={24} />
        <span>No onboarding templates match this filter.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Onboarding templates</caption>
        <thead>
          <tr>
            <th scope="col" className="wx-num-col">
              Order
            </th>
            <th scope="col">Template</th>
            <th scope="col">Origin</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const isSelected = t.id === selectedId;
            const open = (): void => onSelect(t);
            return (
              <tr
                key={t.id}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(open, isSelected)}
              >
                <td className="wx-num-col wx-nums">{t.canonicalOrder}</td>
                <td>
                  <span className="wx-row-title">{t.title}</span>
                  <span className="wx-row-sub wx-data-md">{t.key}</span>
                </td>
                <td>
                  {t.isCanonical ? (
                    <StatusPill label="Canonical" tone="neutral" />
                  ) : (
                    <StatusPill label="Tenant" tone="progress" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Add/edit form in the drawer. Canonical templates are migration-only (the write route refuses
// isCanonical=true), so an edit on a canonical row is read-only and surfaces a GuardChip explaining why.
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
  const drawer = useDrawerA11y<HTMLElement>(onClose);
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
    });
    setSaving(false);
    if (err) {
      setSaveError("Could not save the template.");
      return;
    }
    onSaved();
  }

  return (
    <aside className="wx-admission-drawer" aria-label="Onboarding template" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="check-circle" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>{mode === "add" ? "New template" : "Edit template"}</h2>
          {template ? <span className="wx-row-sub wx-data-md">{template.id}</span> : null}
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          {readOnly ? (
            <GuardChip reason="Canonical templates are platform-seed (migration-only) and cannot be edited." />
          ) : null}
          <TextField
            id="tmpl-key"
            label="Key"
            className="wx-data-md"
            value={key}
            disabled={readOnly || mode === "edit"}
            onChange={(e) => setKey(e.target.value)}
            placeholder="e.g. baa_signed"
          />
          <TextField
            id="tmpl-title"
            label="Title"
            value={title}
            disabled={readOnly}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Human-readable step title"
          />
          <TextField
            id="tmpl-order"
            label="Step order"
            className="wx-nums"
            type="number"
            min={ORDER_MIN}
            max={ORDER_MAX}
            value={order}
            disabled={readOnly}
            onChange={(e) => setOrder(e.target.value)}
          />
          {saveError ? <InlineAlert tone="error">{saveError}</InlineAlert> : null}
          {!readOnly ? (
            <div className="wx-drawer-actions">
              <Button disabled={!canSave || saving} onClick={() => void save()}>
                {saving ? "Saving…" : mode === "add" ? "Add template" : "Save changes"}
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  );
}
