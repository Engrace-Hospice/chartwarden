// apps/web/src/modules/19-oncall — S19.7 TRIAGE PROTOCOL CATALOG (`/triage/protocols`, §5.1, Track B /
// ADR-0030). Spec: WARDENX_UI_ONCALL_ROSTER_PROTOCOLS.md — the Protocol Library tab.
//
// THE CATALOG IS TWO-LAYERED AND ONLY ONE LAYER IS WRITABLE. The platform-floor protocols are org-less and
// system-locked: RLS makes a tenant physically unable to write them, and the write service refuses first
// with the protocol NAMED — because "0 rows updated" is not an answer a DON can act on. A tenant may RAISE
// the floor by authoring its own protocol; it may never lower the platform's. The ✓ badge is that fact,
// rendered, and the edit affordance is absent on those rows rather than present-and-failing.
//
// THE READS ARE NOT PHI. A protocol is a clinical-decision TEMPLATE — a question list and a red-flag
// predicate — with no patient anywhere in it. That is why this screen gates on `triage.read` and why
// authoring gates on the separate `triage.admin_protocol` with a step-up.
//
// TWO THINGS THE §5.1 SPEC ASKS FOR THAT ARE NOT BUILT, both named on the screen:
//   • The SNOMED code is free text validated by pattern, not an M38 lookup: M19 publishes no terminology
//     search and M38's is another module's screen with another module's permission. Putting a second copy
//     of it here would be a second, unaudited vocabulary path.
//   • There is no "publish new version" workflow with drafts isolated from live intake. §4.1 publishes a
//     create and a patch and no draft state — `triage_protocol` has no draft column. Versioning is by
//     EFFECTIVE DATE: a call freezes the protocol version at open, so a newly effective version never
//     switches the questions under a call already walking. That is the real mechanism and the screen says
//     so instead of implying a publish button exists.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type EscalationTier,
  type ShiftDiscipline,
  type TriageProtocolView,
  createProtocol,
  errorMessage,
  listProtocols,
} from "./oncall-api";
import {
  DEFAULT_ESCALATION_TIER,
  DEFAULT_SHIFT_DISCIPLINE,
  ESCALATION_TIERS,
  SHIFT_DISCIPLINES,
  disciplineLabel,
  shortDate,
  tierLabel,
} from "./oncall-status";
import {
  Card,
  CheckboxField,
  CountGrid,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextField,
  alertStyle,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./oncall-ui";

const CATALOG_PAGE = 200;
/** §4.2's `snomedCode` pattern and `key` pattern, mirrored so the form explains itself. */
const SNOMED_RE = /^[0-9]{6,18}$/;
const KEY_RE = /^[a-z0-9_]{2,120}$/;

const DISCIPLINE_FILTERS = [{ value: "", label: "every discipline" }].concat(
  SHIFT_DISCIPLINES.map((d) => ({ value: d, label: disciplineLabel(d) })),
);
const EFFECTIVE_FILTERS = [
  { value: "effective", label: "in force (default)" },
  { value: "all", label: "including retired" },
];

export function TriageProtocolCatalogScreen(): JSX.Element {
  const client = useApiClient();
  const [discipline, setDiscipline] = useState("");
  const [scope, setScope] = useState("effective");
  const [search, setSearch] = useState("");
  const [protocols, setProtocols] = useState<TriageProtocolView[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // author fields
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [snomed, setSnomed] = useState("");
  const [required, setRequired] = useState(DEFAULT_SHIFT_DISCIPLINE);
  const [mandatory, setMandatory] = useState(false);
  const [tier, setTier] = useState(DEFAULT_ESCALATION_TIER);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listProtocols(client, {
      limit: CATALOG_PAGE,
      // `discipline` is always "" (every discipline) or one of SHIFT_DISCIPLINES — the SelectField below
      // offers no other value.
      ...(discipline ? { disciplineRequired: discipline as ShiftDiscipline } : {}),
      ...(scope === "all" ? { effectiveOnly: false } : {}),
      ...(search ? { search } : {}),
    });
    if (res.error) {
      setError(errorMessage(res.error, "The protocol catalog could not be loaded."));
      setLoading(false);
      return;
    }
    setProtocols(res.page?.data ?? []);
    setTruncated(res.page?.has_more ?? false);
    setLoading(false);
  }, [client, discipline, scope, search]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const platform = protocols.filter((p) => p.organizationId === null);
  const tenant = protocols.filter((p) => p.organizationId !== null);
  const mandatoryCount = protocols.filter((p) => p.requiresMandatoryEscalation).length;
  const sorted = [...protocols].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.chiefComplaintLabel.localeCompare(b.chiefComplaintLabel),
  );

  const canCreate =
    KEY_RE.test(key) && label.trim().length >= 3 && SNOMED_RE.test(snomed) && !busy;

  async function commitCreate(): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await createProtocol(client, {
      key,
      chiefComplaintLabel: label,
      snomedCode: snomed,
      // `required`/`tier` are always one of SHIFT_DISCIPLINES / ESCALATION_TIERS — the SelectFields below
      // offer no other value.
      disciplineRequired: required as ShiftDiscipline,
      requiresMandatoryEscalation: mandatory,
      ...(mandatory ? { mandatoryEscalationTier: tier as EscalationTier } : {}),
    });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "The protocol could not be created."));
      return;
    }
    setCreating(false);
    setKey("");
    setLabel("");
    setSnomed("");
    await load();
  }

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Triage protocols</span>}
        breadcrumb="On-call triage · catalog"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button type="button" style={ghostButtonStyle} onClick={() => setCreating(true)}>
              Author a protocol
            </button>
            <Link to="/triage/policy" style={ghostButtonStyle}>
              On-call policy
            </Link>
          </div>
        }
      />

      <Notice tone="info">
        The platform floor ships with the product and is read-only to every tenant role. You may add your
        own protocols and you may make them stricter than the floor; you cannot make the floor weaker.
        Attempting to edit a locked row is refused by name, not silently ignored.
      </Notice>

      <Card title="Catalog">
        <CountGrid
          entries={[
            { label: "In this view", value: protocols.length },
            { label: "Platform floor", value: platform.length },
            { label: "Tenant-authored", value: tenant.length },
            { label: "Carry a mandatory escalation", value: mandatoryCount },
          ]}
        />
        {truncated ? (
          <Notice tone="info">
            More than {CATALOG_PAGE} protocols match; the counts above count the page fetched.
          </Notice>
        ) : null}
      </Card>

      <FilterRow>
        <SelectField
          label="Discipline required"
          value={discipline}
          options={DISCIPLINE_FILTERS}
          onChange={setDiscipline}
        />
        <SelectField label="Show" value={scope} options={EFFECTIVE_FILTERS} onChange={setScope} />
        <TextField label="Search" value={search} onChange={setSearch} placeholder="pain, restlessness…" />
      </FilterRow>

      <Card title="Protocols">
        {sorted.length === 0 ? (
          <span style={mutedStyle}>
            Nothing matches. If you have filtered to tenant-authored only and see nothing, the honest
            reading is "only platform-floor protocols are active" — which is a complete, working catalog.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Chief complaint</th>
                <th style={th}>Key</th>
                <th style={th}>SNOMED</th>
                <th style={th}>Discipline</th>
                <th style={th}>Layer</th>
                <th style={th}>Mandatory escalation</th>
                <th style={thNum}>Questions</th>
                <th style={th}>Version</th>
                <th style={th}>Effective</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.id} style={rowLine}>
                  <td style={td}>
                    <Link to={`/triage/protocols/${p.id}`} style={linkStyle}>
                      {p.chiefComplaintLabel}
                    </Link>
                  </td>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{p.key}</td>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{p.snomedCode}</td>
                  <td style={td}>{disciplineLabel(p.disciplineRequired)}</td>
                  <td style={td}>
                    {p.organizationId === null ? (
                      <StatusPill label="✓ Platform floor" tone="critical" />
                    ) : (
                      <StatusPill label="Tenant" tone="progress" />
                    )}
                  </td>
                  <td style={td}>
                    {p.requiresMandatoryEscalation ? (
                      <StatusPill
                        label={p.mandatoryEscalationTier ? tierLabel(p.mandatoryEscalationTier) : "Yes"}
                        tone="error"
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={tdNum}>{p.questions.length}</td>
                  <td style={{ ...td, fontFamily: t.fontMono }}>{p.version}</td>
                  <td style={td}>
                    {shortDate(p.effectiveFrom)}
                    {p.effectiveTo ? ` → ${shortDate(p.effectiveTo)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          Versioning here is by effective date, not by a draft/publish workflow: there is no draft state on
          a protocol row. A call freezes its protocol version when the protocol is applied, so a version
          that becomes effective mid-call never switches the questions under the clinician walking it.
        </span>
      </Card>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {creating ? (
        <Modal
          title="Author a tenant protocol"
          onClose={() => setCreating(false)}
          footer={
            <button
              type="button"
              disabled={!canCreate}
              style={canCreate ? primaryButtonStyle : disabledButtonStyle}
              title={
                canCreate
                  ? undefined
                  : "A lowercase key, a label of at least 3 characters and a 6–18 digit SNOMED code are required."
              }
              onClick={() => void commitCreate()}
            >
              Create
            </button>
          }
        >
          <Notice tone="warning">
            This write needs a recent step-up. It creates a TENANT protocol — there is no way to mint a
            platform-floor row from here, and the "system locked" flag is not a field, because accepting it
            and ignoring it would leave you believing you had authored a protected question.
          </Notice>
          <TextField
            label="Key"
            value={key}
            onChange={setKey}
            mono
            hint="Lowercase letters, digits and underscores — the stable identifier, not the display label."
          />
          <TextField label="Chief complaint label" value={label} onChange={setLabel} />
          <TextField
            label="SNOMED code"
            value={snomed}
            onChange={setSnomed}
            mono
            hint="6–18 digits, validated by pattern here and by the terminology service at write. There is no code picker on this screen: the vocabulary search belongs to the terminology module and its own permission."
          />
          <SelectField
            label="Discipline required"
            value={required}
            options={SHIFT_DISCIPLINES.map((d) => ({ value: d, label: disciplineLabel(d) }))}
            onChange={setRequired}
          />
          <CheckboxField
            label="This protocol always escalates"
            checked={mandatory}
            onChange={setMandatory}
          />
          {mandatory ? (
            <SelectField
              label="Escalation tier"
              value={tier}
              options={ESCALATION_TIERS.map((x) => ({ value: x, label: tierLabel(x) }))}
              onChange={setTier}
            />
          ) : null}
          <span style={mutedStyle}>
            Questions are added on the protocol's own page after it exists — including the red-flag
            predicate that decides whether an answer raises an escalation.
          </span>
        </Modal>
      ) : null}
    </div>
  );
}
