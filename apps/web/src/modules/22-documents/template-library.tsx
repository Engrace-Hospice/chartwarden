import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — FORM.TemplateLibrary (M22 §5.1, Track B / ADR-0030).
// Spec: §5.1 "FORM.TemplateLibrary" — browse the platform-floor form templates with version metadata; the
// per-template overlay editor (§5.1 FORM.TemplateOverlayEditor, D16 loosen-block) + render preview are admin
// write surfaces that fill in as those paths harden. Built to the Lantern look: Work Queue pattern, §6.6
// status pills, §3.1 mono identifiers (template key), No-Line table (§6.7), warm-paper surfaces. Nav-grouped
// under Admin and gated by `documents.read_templates` — but the SERVER stays the only authz point (ADR-0030).
// Reads GET /api/v1/form-templates (cursor-paginated) via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Mono, ts } from "./lantern";

interface TemplateRow {
  id: string;
  key: string;
  createdAt: string;
}

export function TemplateLibrary(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/form-templates", {});
    if (err) {
      setError("Could not load the form-template library.");
      setLoading(false);
      return;
    }
    setRows((data?.items ?? []) as TemplateRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Form Templates" breadcrumb={<>Admin / Forms</>} />}
      kpis={
        <KpiStrip>
          <KpiCard label="Templates" value={rows.length} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No templates"
            description="No form templates are published for this tenant yet."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Template key</th>
                <th>Id</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Mono>{t.key}</Mono>
                  </td>
                  <td>
                    <Mono>{t.id.slice(0, 8)}</Mono>
                  </td>
                  <td className="tabular-nums">{ts(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
