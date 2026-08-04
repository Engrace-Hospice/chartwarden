// apps/web/src/modules/20-field-safety — §5.1 "HIGH-RISK AREAS" (`/safety/high-risk-areas`,
// Track B / ADR-0030).
//
// D12's advisory polygon registry: geography a Compliance Officer draws so a clinician knows to ring
// first. Every area is ADVISORY — none blocks a visit, none reroutes one, and `requires_buddy_visit` is a
// flag M20 emits for M17 to act on rather than a gate M20 enforces. That sentence is on the screen, not
// only in this comment, because "high-risk area" reads like a barrier to everybody who has not read D12.
//
// ── THE MAP EDITOR §5.1 ASKS FOR IS NOT BUILT, AND THE REASON IS NOT EFFORT ──────────────────────────
//
// §5.1 sketches a Leaflet/MapLibre polygon editor. Two things stand in the way and neither is cosmetic:
//
//   1. **M20-F07 struck PostGIS from Phase 1.** The polygon is `jsonb` rings and point-in-polygon
//      membership is an even-odd ray-cast in app code. Nothing about the storage needs a map — but
//      nothing about it provides one either.
//   2. **A map means tiles, and tiles mean a third party.** Every basemap request sends the viewport to a
//      tile server. On a page whose whole subject is where an agency's clinicians are exposed to harm,
//      that is a disclosure with no agreement covering it, and it would be made by merely OPENING the
//      page — which is the same failure the coordinate boundary on the SOS screen exists to prevent.
//
// So rings are entered and rendered as coordinates, with the validity rules D12 needs — ≥4 points, first
// point equal to last — checked here and again by the server. A polygon a Compliance Officer can read as
// numbers is worse to author and honest about what it costs.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
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
  Card,
  CheckboxField,
  CountGrid,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./safety-ui";

/** One ring per line, `lon,lat lon,lat …`. The format is stated on the field; it is not guessed at. */
function parseRings(text: string): { rings: [number, number][][]; error: string | null } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { rings: [], error: "Enter at least one ring." };
  const rings: [number, number][][] = [];
  for (const [i, line] of lines.entries()) {
    const pts: [number, number][] = [];
    for (const pair of line.split(/\s+/)) {
      const [lonRaw, latRaw] = pair.split(",");
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      if (!Number.isFinite(lon) || !Number.isFinite(lat))
        return { rings: [], error: `Ring ${i + 1}: "${pair}" is not a lon,lat pair.` };
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90)
        return { rings: [], error: `Ring ${i + 1}: ${lon},${lat} is off the globe.` };
      pts.push([lon, lat]);
    }
    // Four points and a closed ring: the two rules the CHECK cannot express and a clinician standing in
    // the polygon at 9 p.m. must not be the one to discover.
    if (pts.length < 4)
      return { rings: [], error: `Ring ${i + 1}: a polygon ring needs at least 4 points.` };
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1])
      return {
        rings: [],
        error: `Ring ${i + 1}: the last point must repeat the first, so the ring is closed.`,
      };
    rings.push(pts);
  }
  return { rings, error: null };
}

function ringsToText(rings: [number, number][][]): string {
  return rings.map((r) => r.map(([lon, lat]) => `${lon},${lat}`).join(" ")).join("\n");
}

export function HighRiskAreasScreen(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<SafetyHighRiskAreaView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeExpired, setIncludeExpired] = useState(false);

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
    // `riskCategory`/`areaPolicy` are always one of the closed vocabularies the SelectFields below offer.
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

  if (loading) return <LoadingSpinner />;
  if (error && rows.length === 0)
    return <EmptyState title="High-risk areas unavailable" description={error} />;

  const now = Date.now();
  const inForce = rows.filter((r) => !r.effectiveTo || Date.parse(r.effectiveTo) > now).length;
  const mandating = rows.filter(
    (r) => r.policyForVisitsToArea === "requires_pre_visit_check_in",
  ).length;
  const buddy = rows.filter((r) => r.policyForVisitsToArea === "requires_buddy_visit").length;

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>High-risk areas</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety" style={ghostButtonStyle}>
              Safety board
            </Link>
            <button type="button" onClick={openNew} style={primaryButtonStyle}>
              Draw an area
            </button>
          </div>
        }
      />

      <Notice tone="info" live>
        <strong>Every area here is advisory (D12).</strong> None blocks a visit, none reroutes one,
        and none can. "Requires a buddy visit" is a flag M20 raises for scheduling to act on — M20
        itself never stops a clinician going. What an area DOES do is put a message in front of her
        before she knocks.
      </Notice>

      <Card title="Registry">
        <CountGrid
          entries={[
            { label: "Areas listed", value: rows.length },
            { label: "In force now", value: inForce },
            { label: "Mandate a pre-visit check-in", value: mandating },
            { label: "Suggest a buddy visit", value: buddy },
          ]}
        />
        <FilterRow>
          <CheckboxField
            label="Include areas that have been retired"
            checked={includeExpired}
            onChange={setIncludeExpired}
          />
        </FilterRow>
        <span style={mutedStyle}>
          The list defaults to what is in force, because the pre-visit advisory must never surface a
          polygon retired last winter. Retired areas are kept — an incident review has to be able to
          ask what advisory was in force on the day.
        </span>
      </Card>

      <Card title="Areas">
        {rows.length === 0 ? (
          <span style={mutedStyle}>
            No areas are registered. That is a normal starting state, not a failure — a tenant that
            has never had an incident in a particular place has nothing to flag.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Category</th>
                <th style={th}>What the clinician sees</th>
                <th style={th}>Visit policy</th>
                <th style={thNum}>Rings</th>
                <th style={thNum}>Points</th>
                <th style={th}>In force</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const retired = r.effectiveTo !== null && Date.parse(r.effectiveTo) <= now;
                return (
                  <tr key={r.id} style={rowLine}>
                    <td style={td}>
                      <StatusPill
                        label={humanize(r.riskCategory)}
                        tone={toneOf(HIGH_RISK_CATEGORY_TONE, r.riskCategory)}
                      />
                      <div style={{ ...mutedStyle, fontFamily: t.fontMono }}>{shortId(r.id)}</div>
                    </td>
                    <td style={td}>{r.advisoryMessage}</td>
                    <td style={td}>{humanize(r.policyForVisitsToArea)}</td>
                    <td style={tdNum}>{r.polygon.length}</td>
                    <td style={tdNum}>{r.polygon.reduce((n, ring) => n + ring.length, 0)}</td>
                    <td style={td}>
                      {dateTime(r.effectiveFrom)}
                      <div style={mutedStyle}>
                        {r.effectiveTo ? `→ ${dateTime(r.effectiveTo)}` : "→ no end"}
                      </div>
                      {retired ? <StatusPill label="Retired" tone="neutral" /> : null}
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => openEdit(r)} style={ghostButtonStyle}>
                          Edit
                        </button>
                        {retired ? null : (
                          <button
                            type="button"
                            onClick={() => void retire(r)}
                            style={ghostButtonStyle}
                          >
                            Retire now
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Why there is no map here">
        <span style={mutedStyle}>
          A basemap means tile requests, and a tile request sends this viewport to a third party. On
          a page whose subject is where an agency's clinicians are exposed to harm, that disclosure
          would be made by merely opening the screen — the same failure the coordinate boundary on
          the SOS page exists to prevent, and with no agreement covering it. Rings are therefore
          entered and read as coordinates. Storage does not need a map either: M20-F07 struck
          PostGIS from Phase 1, so the polygon is JSON rings and membership is an even-odd ray-cast
          in application code.
        </span>
      </Card>

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
              {saving ? "Saving…" : editing === "new" ? "Create area" : "Save changes"}
            </button>
          }
        >
          <SelectField
            label="Category"
            value={riskCategory}
            options={HIGH_RISK_CATEGORIES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setRiskCategory}
          />
          <TextField
            label="Advisory message (≤200 characters)"
            value={advisoryMessage}
            onChange={setAdvisoryMessage}
            hint="This exact sentence is what a clinician reads on her pre-visit card. Write it for her, not for the file."
          />
          <TextAreaField
            label="Polygon rings"
            value={ringText}
            onChange={setRingText}
            rows={6}
            hint="One ring per line; each ring is space-separated lon,lat pairs (SRID 4326), at least four points, and the last point must repeat the first. The first line is the outer boundary; any further lines are holes."
          />
          <SelectField
            label="Visit policy for this area"
            value={areaPolicy}
            options={HIGH_RISK_AREA_POLICIES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setAreaPolicy}
          />
          {areaPolicy === "requires_buddy_visit" ? (
            <Notice tone="warning">
              This raises a flag for scheduling. It does not pair anybody, and it does not stop a
              solo visit — M20 emits, M17 routes, and neither blocks.
            </Notice>
          ) : null}
          {editing === "new" ? (
            <TextField
              label="Effective from"
              value={effectiveFrom}
              onChange={setEffectiveFrom}
              type="datetime-local"
              hint="Leave blank for 'now'."
            />
          ) : null}
          <TextField
            label="Effective to"
            value={effectiveTo}
            onChange={setEffectiveTo}
            type="datetime-local"
            hint="Retiring an area is an end date, never a delete — a review has to be able to ask what advisory was in force on the day."
          />
          {modalError ? (
            <Notice tone="error" assertive>
              {modalError}
            </Notice>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
