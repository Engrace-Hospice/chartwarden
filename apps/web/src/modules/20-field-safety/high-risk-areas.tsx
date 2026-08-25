// apps/web/src/modules/20-field-safety - §5.1 "HIGH-RISK AREAS" (`/safety/high-risk-areas`,
// Track B / ADR-0030).
//
// D12's advisory polygon registry. Areas warn; they do not block visits.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  OffsetPagination,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyHighRiskAreaView,
  type SafetyHighRiskCategory,
  type SafetyHighRiskPolicy,
  createHighRiskArea,
  errorMessage,
  listHighRiskAreas,
  patchHighRiskArea,
} from "./safety-api";
import {
  DEFAULT_HIGH_RISK_AREA_POLICY,
  DEFAULT_HIGH_RISK_CATEGORY,
  HIGH_RISK_AREA_POLICIES,
  HIGH_RISK_CATEGORIES,
  HIGH_RISK_CATEGORY_TONE,
  dateTime,
  humanize,
  shortId,
  toInstant,
  toneOf,
} from "./safety-status";
import {
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  disabledButtonStyle,
  primaryButtonStyle,
} from "./safety-ui";

const PAGE_SIZES = [5, 10, 15, 20, 30, 50] as const;

function parseRings(text: string): { rings: [number, number][][]; error: string | null } {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { rings: [], error: "Enter at least one ring." };
  const rings: [number, number][][] = [];
  for (const [index, line] of lines.entries()) {
    const points: [number, number][] = [];
    for (const pair of line.split(/\s+/)) {
      const [lonRaw, latRaw] = pair.split(",");
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (!Number.isFinite(lon) || !Number.isFinite(lat))
        return { rings: [], error: `Ring ${index + 1}: "${pair}" is not a lon,lat pair.` };
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90)
        return { rings: [], error: `Ring ${index + 1}: ${lon},${lat} is off the globe.` };
      points.push([lon, lat]);
    }
    if (points.length < 4)
      return { rings: [], error: `Ring ${index + 1}: a polygon ring needs at least 4 points.` };
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1])
      return {
        rings: [],
        error: `Ring ${index + 1}: the last point must repeat the first, so the ring is closed.`,
      };
    rings.push(points);
  }
  return { rings, error: null };
}

function ringsToText(rings: [number, number][][]): string {
  return rings.map((ring) => ring.map(([lon, lat]) => `${lon},${lat}`).join(" ")).join("\n");
}

export function HighRiskAreasScreen(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<SafetyHighRiskAreaView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [editing, setEditing] = useState<SafetyHighRiskAreaView | "new" | null>(null);
  const [riskCategory, setRiskCategory] = useState(DEFAULT_HIGH_RISK_CATEGORY);
  const [advisoryMessage, setAdvisoryMessage] = useState("");
  const [ringText, setRingText] = useState("");
  const [areaPolicy, setAreaPolicy] = useState(DEFAULT_HIGH_RISK_AREA_POLICY);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listHighRiskAreas(client, { limit: 200, includeExpired });
    if (res.error || !res.page) {
      setError(errorMessage(res.error, "The high-risk-area registry could not be read."));
      setRows([]);
    } else {
      setRows(res.page.data);
      setError(null);
    }
    setLoading(false);
  }, [client, includeExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = useCallback(() => {
    setRiskCategory(DEFAULT_HIGH_RISK_CATEGORY);
    setAdvisoryMessage("");
    setRingText("");
    setAreaPolicy(DEFAULT_HIGH_RISK_AREA_POLICY);
    setEffectiveFrom("");
    setEffectiveTo("");
    setModalError(null);
    setEditing("new");
  }, []);

  const openEdit = useCallback((area: SafetyHighRiskAreaView) => {
    setRiskCategory(area.riskCategory);
    setAdvisoryMessage(area.advisoryMessage);
    setRingText(ringsToText(area.polygon));
    setAreaPolicy(area.policyForVisitsToArea);
    setEffectiveFrom("");
    setEffectiveTo("");
    setModalError(null);
    setEditing(area);
  }, []);

  const save = useCallback(async () => {
    const parsed = parseRings(ringText);
    if (parsed.error) {
      setModalError(parsed.error);
      return;
    }
    setSaving(true);
    setModalError(null);
    const res =
      editing === "new"
        ? await createHighRiskArea(client, {
            riskCategory: riskCategory as SafetyHighRiskCategory,
            advisoryMessage: advisoryMessage.trim(),
            polygon: parsed.rings,
            policyForVisitsToArea: areaPolicy as SafetyHighRiskPolicy,
            ...(effectiveFrom ? { effectiveFrom: toInstant(effectiveFrom) } : {}),
            ...(effectiveTo ? { effectiveTo: toInstant(effectiveTo) } : {}),
          })
        : await patchHighRiskArea(client, (editing as SafetyHighRiskAreaView).id, {
            riskCategory: riskCategory as SafetyHighRiskCategory,
            advisoryMessage: advisoryMessage.trim(),
            polygon: parsed.rings,
            policyForVisitsToArea: areaPolicy as SafetyHighRiskPolicy,
            ...(effectiveTo ? { effectiveTo: toInstant(effectiveTo) } : {}),
          });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The area was not saved."));
      return;
    }
    setEditing(null);
    await load();
  }, [
    advisoryMessage,
    areaPolicy,
    client,
    editing,
    effectiveFrom,
    effectiveTo,
    load,
    riskCategory,
    ringText,
  ]);

  const retire = useCallback(
    async (area: SafetyHighRiskAreaView) => {
      const res = await patchHighRiskArea(client, area.id, {
        effectiveTo: new Date().toISOString(),
      });
      if (res.error) {
        setError(errorMessage(res.error, "The area was not retired."));
        return;
      }
      await load();
    },
    [client, load],
  );

  const activePage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const pagedRows = useMemo(
    () => rows.slice((activePage - 1) * pageSize, activePage * pageSize),
    [activePage, pageSize, rows],
  );

  if (loading && rows.length === 0) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="High-risk areas unavailable" description={error} />
      </div>
    );
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="High-Risk Areas"
          breadcrumb="Field safety"
          actions={
            <div style={actionGroupStyle}>
              <Link to="/safety" style={linkButtonStyle}>
                Safety board
              </Link>
              <Button type="button" tone="primary" onClick={openNew}>
                Draw area
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Advisory polygon registry. Areas warn clinicians before a visit; M20 does not block
            routing.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <Notice tone="warning" live>
              {error} The table below is the last registry read that answered.
            </Notice>
          ) : null}
          <Notice tone="info" live>
            Every area here is advisory. A buddy-visit policy is surfaced for scheduling to act on;
            it does not stop a solo visit by itself.
          </Notice>
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Registry controls</span>
              <strong>Choose whether retired areas are included in this read</strong>
            </div>
            <div style={controlGroupStyle}>
              <label style={checkboxLabelStyle}>
                <input
                  type="checkbox"
                  checked={includeExpired}
                  onChange={(event) => {
                    setIncludeExpired(event.target.checked);
                    setPage(1);
                  }}
                />
                Include retired
              </label>
              <Button size="sm" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
          </div>
        </div>
      }
      table={
        <div style={tableWrapStyle}>
          {rows.length === 0 ? (
            <div style={{ padding: "2rem 0" }}>
              <EmptyState
                title="No high-risk areas"
                description="No advisory areas are registered for this read."
                action={
                  <Button size="sm" tone="primary" onClick={openNew}>
                    Draw area
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "15%" }}>Category</th>
                    <th style={{ ...thStyle, width: "28%" }}>Clinician advisory</th>
                    <th style={{ ...thStyle, width: "17%" }}>Visit policy</th>
                    <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Rings</th>
                    <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Points</th>
                    <th style={{ ...thStyle, width: "16%" }}>In force</th>
                    <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row) => (
                    <HighRiskAreaRow key={row.id} row={row} onEdit={openEdit} onRetire={retire} />
                  ))}
                </tbody>
              </table>
              <OffsetPagination
                page={activePage}
                pageSize={pageSize}
                totalItems={rows.length}
                onPageChange={setPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
                pageSizeOptions={PAGE_SIZES}
                noun="areas"
              />
            </>
          )}
          <div role="note" style={noteStyle}>
            <StatusPill label="No basemap" tone="neutral" />
            <span>
              Basemap tiles would disclose the viewport to a third party. Rings are entered as
              coordinates and validated again by the server.
            </span>
          </div>
          {editing !== null ? (
            <Modal
              title={editing === "new" ? "Draw a high-risk area" : "Edit this area"}
              onClose={() => setEditing(null)}
              footer={
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={
                    saving || advisoryMessage.trim().length === 0 || ringText.trim().length === 0
                  }
                  style={
                    saving || advisoryMessage.trim().length === 0 || ringText.trim().length === 0
                      ? disabledButtonStyle
                      : primaryButtonStyle
                  }
                >
                  {saving ? "Saving..." : editing === "new" ? "Create area" : "Save changes"}
                </button>
              }
            >
              <SelectField
                label="Category"
                value={riskCategory}
                options={HIGH_RISK_CATEGORIES.map((value) => ({ value, label: humanize(value) }))}
                onChange={setRiskCategory}
              />
              <TextField
                label="Advisory message (<=200 characters)"
                value={advisoryMessage}
                onChange={setAdvisoryMessage}
                hint="This exact sentence is what a clinician reads on the pre-visit card."
              />
              <TextAreaField
                label="Polygon rings"
                value={ringText}
                onChange={setRingText}
                rows={6}
                hint="One ring per line; each ring is space-separated lon,lat pairs, at least four points, and the last point must repeat the first."
              />
              <SelectField
                label="Visit policy for this area"
                value={areaPolicy}
                options={HIGH_RISK_AREA_POLICIES.map((value) => ({
                  value,
                  label: humanize(value),
                }))}
                onChange={setAreaPolicy}
              />
              {areaPolicy === "requires_buddy_visit" ? (
                <Notice tone="warning">
                  This raises a flag for scheduling. It does not pair anybody and it does not stop a
                  solo visit.
                </Notice>
              ) : null}
              {editing === "new" ? (
                <TextField
                  label="Effective from"
                  value={effectiveFrom}
                  onChange={setEffectiveFrom}
                  type="datetime-local"
                  hint="Leave blank for now."
                />
              ) : null}
              <TextField
                label="Effective to"
                value={effectiveTo}
                onChange={setEffectiveTo}
                type="datetime-local"
                hint="Retiring an area is an end date, never a delete."
              />
              {modalError ? (
                <Notice tone="error" assertive>
                  {modalError}
                </Notice>
              ) : null}
            </Modal>
          ) : null}
        </div>
      }
      fullPageScroll
    />
  );
}

function HighRiskAreaRow({
  row,
  onEdit,
  onRetire,
}: {
  row: SafetyHighRiskAreaView;
  onEdit: (area: SafetyHighRiskAreaView) => void;
  onRetire: (area: SafetyHighRiskAreaView) => Promise<void>;
}): JSX.Element {
  const retired = row.effectiveTo !== null && Date.parse(row.effectiveTo) <= Date.now();
  return (
    <tr style={rowStyle}>
      <td style={tdStyle}>
        <div style={primaryCellStyle}>
          <StatusPill
            label={humanize(row.riskCategory)}
            tone={toneOf(HIGH_RISK_CATEGORY_TONE, row.riskCategory)}
          />
          <code className="wx-data-md" style={inlineCodeStyle}>
            {shortId(row.id)}
          </code>
        </div>
      </td>
      <td style={tdStyle}>{row.advisoryMessage}</td>
      <td style={tdStyle}>{humanize(row.policyForVisitsToArea)}</td>
      <td style={tdNumStyle}>{row.polygon.length}</td>
      <td style={tdNumStyle}>{row.polygon.reduce((total, ring) => total + ring.length, 0)}</td>
      <td style={tdStyle}>
        <div style={primaryCellStyle}>
          <span>{dateTime(row.effectiveFrom)}</span>
          <span style={secondaryTextStyle}>
            {row.effectiveTo ? `to ${dateTime(row.effectiveTo)}` : "no end"}
          </span>
          {retired ? <StatusPill label="Retired" tone="neutral" /> : null}
        </div>
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        <div style={actionCellStyle}>
          <Button size="sm" tone="secondary" onClick={() => onEdit(row)}>
            Edit
          </Button>
          {retired ? null : (
            <Button size="sm" tone="tertiary" onClick={() => void onRetire(row)}>
              Retire
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

const actionGroupStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.5rem",
};
const linkButtonStyle = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
};
const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const checkboxLabelStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  minHeight: "2.25rem",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
const tableWrapStyle = {
  width: "100%",
  overflowX: "auto" as const,
  padding: "0 1.5rem 1.5rem",
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const tdNumStyle = {
  ...tdStyle,
  textAlign: "right" as const,
  fontVariantNumeric: "tabular-nums",
};
const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "flex-start",
  gap: "0.25rem",
  minWidth: 0,
};
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const inlineCodeStyle = {
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
const actionCellStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  marginTop: "1rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
