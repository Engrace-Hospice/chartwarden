/**
 * ChartWarden — vendor-agreement register gate (`arch:vendor-agreements`, CW-BA-01)
 * ---------------------------------------------------------------------------------
 * `compliance/vendor-agreements.yaml` is the machine-checked register of who holds ChartWarden's PHI (or sits
 * next to it) and under what agreement. It is METADATA ONLY: vendor, scope, status, dates and an opaque
 * reference to where the owner keeps the signed document. No contract text, signature or contact detail.
 *
 * This gate fails when:
 *   1. the register is missing, unparseable or empty, or a row is incomplete or inconsistent (below);
 *   2. an integration the architecture's inventory (INTEGRATIONS §2) marks as needing a BAA is claimed by no row
 *      (`inventory:` is how a row says which §2 integration it covers), or a row claims one that does not exist,
 *      or a row that says `phi: none` claims one that needs a BAA;
 *   3. a vendor that receives PHI (`phi: receives`) or sits next to it (`adjacent`: no PHI by rule, but metadata
 *      and delivery state are handled, and the BAA is kept as defence in depth) has no agreement kind, reads
 *      `not-required`, or names no evidence file showing where the flow or hosting is declared;
 *   4. a row reads `signed` without `signedOn` (not in the future), a `documentRef` (opaque, never a URL),
 *      `confirmedBy` (a ROLE, never a person) and `confirmedOn`; or a row that is not signed carries any of them.
 *      A person confirms a signature; the gate only refuses a `signed` row that lacks the proof of one;
 *   5. a `tenant-held` row (the agreement is the tenant's own, recorded per tenant in the database) does not
 *      name the control that tracks it (`trackedBy`), or names one `compliance/controls.yaml` does not have;
 *   6. the file text (comments included) carries an email, a URL or a phone number, a key the schema does not
 *      name appears (the schema is closed, so pasted text has no column to hide in), or `scope`/`note` is long
 *      enough to be pasted contract text; the owner is missing, or `review_by` is past or more than
 *      MAX_REVIEW_DAYS out (the controls-register rule, so a pending row cannot sit unexamined).
 *
 * The §2 reader is header-driven and fails closed (a missing header, a shifted column or a malformed row reads
 * as "could not be read", never as "no BAA needed"), and a BAA cell it does not recognise as No / N/A / via
 * requires a row: a new wording must be decided by a person, not skipped.
 *
 * What it does NOT prove: that a document exists or says what the row claims; that the inventory names every
 * vendor (a hosting or backup provider is not in §2, so `evidence:` is the reviewer's trail, not a detector);
 * or that PHI stops flowing to a vendor whose row is `pending`. Those stay in the CW-BA-01 gap.
 *
 * VALIDITY AND EXPIRY (CW-AC-14, CW-AC-17). A `signed` row is judged as valid, not only as filed:
 *   7. it carries `effectiveOn`, and that date is not in the future (an agreement that is not in force yet does not
 *      cover today's flow);
 *   8. `expiresOn`, when present, is not past: an agreement that ended is not a signed one, so the gate FAILS CLOSED
 *      on the day after it (renew it and record the new term, or flip the row back to `pending`). A signed row with no
 *      `expiresOn` is open-ended: the owner states no end date, the review date is its only clock;
 *   9. `covers` lists what the executed agreement covers (closed set {@link COVERAGE}) and must include `phi` for a
 *      vendor that receives PHI and everything the row's own `requires` names (Anthropic needs its zero-data-retention
 *      addendum: the BAA alone does not cover the use). A person states what it covers; the gate only refuses a
 *      signed row whose stated coverage is short of the use.
 * Ahead of the end date, {@link vendorAgreementWarnings} names every signed row that expires within
 * {@link EXPIRY_WARN_DAYS} days; the gate prints it and still passes. The tenant-held agreements and the platform's tenant BAA
 * register have their own end-date rules in the database (CW-AC-17: the tenant clearinghouse BAA; CW-AC-14: M34).
 *
 * Do not start a second register: a further column goes to {@link Agreement} and the closed schema below.
 *
 * Run:   bun run scripts/check-vendor-agreements.ts
 * CI:    exits 1 on any violation (arch:fitness stage).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_REVIEW_DAYS } from "./check-compliance-controls";

export const REGISTER_PATH = "compliance/vendor-agreements.yaml";
export const INVENTORY_DOC = "docs/architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md";

export const PHI_CLASSES = ["receives", "adjacent", "none"] as const;
export const AGREEMENT_KINDS = ["baa", "trading-partner", "none"] as const;
export const AGREEMENT_STATUSES = ["pending", "signed", "tenant-held", "not-required"] as const;
/** What an executed agreement can be stated to cover. `phi` is the BAA itself; the rest are addenda a row may require. */
export const COVERAGE = ["phi", "zero-data-retention"] as const;
/** A signed agreement ending within this many days is named by {@link vendorAgreementWarnings} (the M34 go-live guard's window). */
export const EXPIRY_WARN_DAYS = 90;

const MIN_SCOPE_CHARS = 30;
/** Past this a field is prose, not metadata: the file never holds contract text. */
const MAX_TEXT_CHARS = 600;
const MAX_NAME_CHARS = 120;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{2,40}$/;
/** Roles that may confirm that an agreement is executed. Add one here, deliberately, when the organisation has it. */
export const CONFIRMING_ROLES = ["privacy-officer", "security-officer"] as const;
/**
 * Opaque pointer to where the signed document is kept: `<store>:<id>` (for example `vault:acme-baa-2026`). Never a
 * URL, a host or an address: the id has no `.`, so a hostname, an IP address and `first.last` all fail.
 */
const DOCUMENT_REF_PATTERN = /^[a-z][a-z0-9-]{1,20}:[A-Za-z0-9][A-Za-z0-9_/#-]{2,100}$/;
const DENIED_REF_SCHEME = /^(?:https?|ftps?|sftp|ssh|s3|gs|mailto|file|tel|sms|data|javascript):/i;
const PLACEHOLDER =
  /^(?:tbd|to be determined|todo|unknown|unrecorded|unnamed|pending|placeholder|dummy|sample|example|fake|xxx+|n\/a|none)\b/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
/** An email, a URL, or a phone number (ten digits with or without separators, or international). */
const CONTACT_PATTERNS: readonly RegExp[] = [
  /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/,
  /\b(?:https?|ftps?|sftp|ssh|s3|gs):\/\//i,
  /\bmailto:/i,
  /\bwww\./i,
  /(?<!\d)(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/,
  /\+\d[\d\s().-]{7,}\d/,
];
/** Fields that only a signed row may carry. */
const SIGNED_ONLY_FIELDS = [
  "signedOn",
  "documentRef",
  "confirmedBy",
  "confirmedOn",
  "effectiveOn",
  "expiresOn",
  "covers",
] as const;
/**
 * The controls that record a tenant's OWN vendor agreement per tenant in the database, and the §2 inventory rows
 * each covers. A `tenant-held` row may name only these controls and claim only these rows: an id that merely
 * exists in controls.yaml would otherwise stand in for a recorded agreement and skip the `signed` proof. A later
 * control that records tenants' own agreements adds itself here, deliberately.
 */
export const TENANT_HELD_CONTROLS: Readonly<Record<string, readonly number[]>> = {
  "CW-AC-17": [35],
};
/** The closed schema: a key not named here fails the gate. A later control adds its column here first. */
const REGISTER_KEYS = ["owner", "review_by", "vendors"] as const;
const ROW_KEYS = [
  "id",
  "name",
  "phi",
  "inventory",
  "scope",
  "evidence",
  "requires",
  "note",
  "agreement",
] as const;
const AGREEMENT_KEYS = [
  "kind",
  "status",
  "signedOn",
  "documentRef",
  "confirmedBy",
  "confirmedOn",
  "trackedBy",
  "effectiveOn",
  "expiresOn",
  "covers",
] as const;

type DateLike = string | Date;

export interface Agreement {
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly signedOn?: DateLike | undefined;
  readonly documentRef?: string | undefined;
  readonly confirmedBy?: string | undefined;
  readonly confirmedOn?: DateLike | undefined;
  /** tenant-held only: ids of the controls in compliance/controls.yaml that record the tenant's own agreement. */
  readonly trackedBy?: readonly string[] | undefined;
  /** Signed rows: the day the agreement took effect (required, not in the future). */
  readonly effectiveOn?: DateLike | undefined;
  /** Signed rows: the last day it is in force. Absent = open-ended. Past = the gate fails (an ended agreement is not signed). */
  readonly expiresOn?: DateLike | undefined;
  /** Signed rows: what the executed agreement covers, from {@link COVERAGE}; must meet the row's use. */
  readonly covers?: readonly string[] | undefined;
}

export interface VendorRow {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly phi?: string | undefined;
  /** §2 inventory numbers (INTEGRATIONS) this row covers. */
  readonly inventory?: readonly number[] | undefined;
  readonly scope?: string | undefined;
  /** Repo files that show where the PHI flow or the hosting is declared. */
  readonly evidence?: readonly string[] | undefined;
  /** Coverage beyond `phi` this vendor's use needs from its agreement (for example `zero-data-retention`). */
  readonly requires?: readonly string[] | undefined;
  readonly note?: string | undefined;
  readonly agreement?: Agreement | undefined;
}

export interface VendorRegister {
  readonly owner?: string | undefined;
  readonly review_by?: DateLike | undefined;
  readonly vendors?: readonly VendorRow[] | undefined;
}

export interface InventoryRow {
  readonly number: number;
  readonly integration: string;
  readonly baaRequired: boolean;
}

export interface CheckInputs {
  readonly register: VendorRegister | undefined;
  /** The register file's raw text, comments included, scanned for contact details. Skipped when undefined. */
  readonly rawText?: string | undefined;
  readonly inventory: readonly InventoryRow[];
  readonly controlIds: ReadonlySet<string>;
  readonly fileExists: (path: string) => boolean;
  readonly today: Date;
}

const dateOnly = (v: DateLike | undefined): string | undefined =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v === undefined ? undefined : String(v);

/** A real calendar date in YYYY-MM-DD form, or undefined. */
function isoDate(v: DateLike | undefined): string | undefined {
  const s = dateOnly(v);
  if (s === undefined || !ISO_DATE.test(s)) return undefined;
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : undefined;
}

/** Whole calendar days from `today`'s UTC date to `iso` (a time of day on `today` never shifts the answer). */
const daysFrom = (today: Date, iso: string): number =>
  Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`)) /
      MS_PER_DAY,
  );

function unknownKeys(value: object, allowed: readonly string[], label: string): string[] {
  return Object.keys(value)
    .filter((k) => !allowed.includes(k))
    .map(
      (k) =>
        `${label}: unknown key \`${k}\`: the register is a closed schema (add the column to scripts/check-vendor-agreements.ts first)`,
    );
}

const oneOf = (set: readonly string[], v: string | undefined): boolean =>
  v !== undefined && set.includes(v);

function hasContactDetail(value: unknown): boolean {
  if (typeof value === "string") return CONTACT_PATTERNS.some((p) => p.test(value));
  if (Array.isArray(value)) return value.some(hasContactDetail);
  if (value !== null && typeof value === "object")
    return Object.values(value).some(hasContactDetail);
  return false;
}

/** id, name, phi, scope, note: the row's own words. */
function shapeViolations(r: VendorRow, label: string): string[] {
  const v: string[] = [];
  if (!r.id) v.push(`${label}: no \`id\``);
  else if (!ID_PATTERN.test(r.id))
    v.push(`${label}: id must be lowercase kebab-case (a-z, 0-9 and -)`);
  if (!r.name?.trim()) v.push(`${label}: no \`name\``);
  else if (r.name.length > MAX_NAME_CHARS)
    v.push(`${label}: name is ${r.name.length} characters (max ${MAX_NAME_CHARS})`);
  v.push(...unknownKeys(r, ROW_KEYS, label));
  if (r.agreement) v.push(...unknownKeys(r.agreement, AGREEMENT_KEYS, `${label}: agreement`));
  if (!oneOf(PHI_CLASSES, r.phi))
    v.push(`${label}: phi \`${r.phi}\` is not one of ${PHI_CLASSES.join(", ")}`);
  const scope = (r.scope ?? "").trim();
  if (scope.length < MIN_SCOPE_CHARS)
    v.push(
      `${label}: scope must say what data the vendor handles (at least ${MIN_SCOPE_CHARS} characters)`,
    );
  for (const [field, text] of [
    ["scope", r.scope],
    ["note", r.note],
  ] as const)
    if ((text ?? "").length > MAX_TEXT_CHARS)
      v.push(
        `${label}: ${field} is ${text?.length} characters (max ${MAX_TEXT_CHARS}): this file holds metadata, never contract text`,
      );
  if (hasContactDetail(r))
    v.push(`${label}: contact detail (an email, URL or phone number) found: this file holds none`);
  return v;
}

/** What the vendor's exposure to PHI requires of its agreement and its evidence. */
function exposureViolations(
  r: VendorRow,
  label: string,
  fileExists: (p: string) => boolean,
): string[] {
  const v: string[] = [];
  const a = r.agreement;
  if (!a) return [`${label}: no \`agreement\``];
  if (!oneOf(AGREEMENT_KINDS, a.kind))
    v.push(`${label}: agreement.kind \`${a.kind}\` is not one of ${AGREEMENT_KINDS.join(", ")}`);
  if (!oneOf(AGREEMENT_STATUSES, a.status))
    v.push(
      `${label}: agreement.status \`${a.status}\` is not one of ${AGREEMENT_STATUSES.join(", ")}`,
    );
  if (r.phi === "none" && (a.kind !== "none" || a.status !== "not-required"))
    v.push(`${label}: phi \`none\` must be agreement.kind none and status not-required`);
  if (r.phi === "receives" || r.phi === "adjacent") {
    if (a.kind === "none")
      v.push(`${label}: phi \`${r.phi}\` needs agreement.kind baa or trading-partner`);
    if (a.status === "not-required")
      v.push(`${label}: phi \`${r.phi}\` cannot be \`not-required\``);
    if ((r.evidence ?? []).length === 0)
      v.push(
        `${label}: needs at least one evidence file (where the PHI flow or hosting is declared)`,
      );
  }
  for (const f of r.evidence ?? []) {
    if (f.startsWith("/") || f.split("/").includes(".."))
      v.push(`${label}: evidence file \`${f}\` must be a path inside the repository`);
    else if (!fileExists(f)) v.push(`${label}: evidence file \`${f}\` does not exist`);
  }
  return v;
}

/** A signed row carries its proof; a row that is not signed carries none of it. */
function signedViolations(r: VendorRow, label: string, today: Date): string[] {
  const a = r.agreement;
  if (!a) return [];
  const v: string[] = [];
  if (a.status !== "signed") {
    const carried = SIGNED_ONLY_FIELDS.filter((f) => a[f] !== undefined);
    if (carried.length > 0)
      v.push(
        `${label}: status ${a.status} must not carry ${carried.join(", ")}: a row that is not signed must not look signed`,
      );
    return v;
  }
  if (PLACEHOLDER.test(r.name ?? ""))
    v.push(`${label}: a signed row needs a real vendor name, not a placeholder`);
  const signedOn = isoDate(a.signedOn);
  if (signedOn === undefined) v.push(`${label}: signed needs agreement.signedOn (YYYY-MM-DD)`);
  else if (daysFrom(today, signedOn) > 0)
    v.push(`${label}: agreement.signedOn ${signedOn} is in the future`);
  if (!a.documentRef) v.push(`${label}: signed needs agreement.documentRef`);
  else if (
    !DOCUMENT_REF_PATTERN.test(a.documentRef) ||
    DENIED_REF_SCHEME.test(a.documentRef) ||
    PLACEHOLDER.test(a.documentRef.slice(a.documentRef.indexOf(":") + 1))
  )
    v.push(
      `${label}: agreement.documentRef must be an opaque \`<store>:<id>\` reference (for example vault:acme-baa-2026), never a URL, an address or a placeholder`,
    );
  if (!a.confirmedBy) v.push(`${label}: signed needs agreement.confirmedBy (a role)`);
  else if (!(CONFIRMING_ROLES as readonly string[]).includes(a.confirmedBy))
    v.push(
      `${label}: agreement.confirmedBy must be one of ${CONFIRMING_ROLES.join(", ")} (a role, never a person)`,
    );
  const confirmedOn = isoDate(a.confirmedOn);
  if (confirmedOn === undefined)
    v.push(`${label}: signed needs agreement.confirmedOn (YYYY-MM-DD)`);
  else if (daysFrom(today, confirmedOn) > 0)
    v.push(`${label}: agreement.confirmedOn ${confirmedOn} is in the future`);
  else if (signedOn !== undefined && confirmedOn < signedOn)
    v.push(`${label}: agreement.confirmedOn ${confirmedOn} is before signedOn ${signedOn}`);
  return v;
}

/** `tenant-held`: the agreement is the tenant's own, so a control that exists must track it. */
function tenantHeldViolations(
  r: VendorRow,
  label: string,
  controlIds: ReadonlySet<string>,
): string[] {
  const a = r.agreement;
  if (!a) return [];
  const tracked = a.trackedBy ?? [];
  if (a.status !== "tenant-held")
    return tracked.length > 0
      ? [`${label}: agreement.trackedBy only belongs on a tenant-held row`]
      : [];
  if (tracked.length === 0)
    return [
      `${label}: tenant-held needs agreement.trackedBy (the control that records the tenant's agreement)`,
    ];
  const v: string[] = [];
  const recording = Object.keys(TENANT_HELD_CONTROLS).join(", ");
  for (const id of tracked) {
    if (!controlIds.has(id))
      v.push(
        `${label}: agreement.trackedBy \`${id}\` is not a control in compliance/controls.yaml`,
      );
    else if (!Object.hasOwn(TENANT_HELD_CONTROLS, id))
      v.push(
        `${label}: agreement.trackedBy \`${id}\` does not record a tenant's own agreement (${recording} do)`,
      );
  }
  const covered = new Set(tracked.flatMap((id) => TENANT_HELD_CONTROLS[id] ?? []));
  for (const n of r.inventory ?? [])
    if (!covered.has(n))
      v.push(
        `${label}: tenant-held cannot claim inventory row ${n}: ${tracked.join(", ")} records tenants' own agreements only for row(s) ${[...covered].join(", ") || "none"}`,
      );
  return v;
}

/**
 * `effectiveOn` / `expiresOn`: shape and order for any row that carries them, and for a SIGNED row the window against
 * `today`: in force (effective, not past its end). A row that is not signed must carry neither (`signedViolations`).
 */
export function validityViolations(r: VendorRow, label: string, today: Date): string[] {
  const a = r.agreement;
  if (!a) return [];
  const v: string[] = [];
  for (const field of ["effectiveOn", "expiresOn"] as const)
    if (a[field] !== undefined && isoDate(a[field]) === undefined)
      v.push(`${label}: agreement.${field} must be a YYYY-MM-DD date`);
  const effective = isoDate(a.effectiveOn);
  const expires = isoDate(a.expiresOn);
  if (effective !== undefined && expires !== undefined && expires <= effective)
    v.push(`${label}: agreement.expiresOn ${expires} is not after effectiveOn ${effective}`);
  if (a.status !== "signed") return v;
  if (a.effectiveOn === undefined)
    v.push(
      `${label}: signed needs agreement.effectiveOn (YYYY-MM-DD): the day the agreement took effect`,
    );
  else if (effective !== undefined && daysFrom(today, effective) > 0)
    v.push(
      `${label}: agreement.effectiveOn ${effective} is in the future: not in force yet, so it does not cover today's flow`,
    );
  if (expires !== undefined && daysFrom(today, expires) < 0)
    v.push(
      `${label}: agreement expired on ${expires} (${-daysFrom(today, expires)} day(s) ago): an ended agreement is not a signed one; renew it and record the new term, or flip the row back to pending`,
    );
  return v;
}

/**
 * `covers` / `requires`: what the executed agreement covers against what the vendor's use needs. A vendor that receives PHI
 * needs `phi`; a row may require more (`requires`). A row that is not signed carries no `covers` (`signedViolations`).
 */
function coverageViolations(r: VendorRow, label: string): string[] {
  const a = r.agreement;
  if (!a) return [];
  const v: string[] = [];
  const known = (c: unknown): boolean =>
    typeof c === "string" && (COVERAGE as readonly string[]).includes(c);
  for (const [field, list] of [
    ["requires", r.requires],
    ["agreement.covers", a.covers],
  ] as const)
    for (const c of list ?? [])
      if (!known(c))
        v.push(`${label}: ${field} \`${String(c)}\` is not one of ${COVERAGE.join(", ")}`);
  if (a.status !== "signed") return v;
  const covers = new Set(a.covers ?? []);
  if (covers.size === 0)
    v.push(
      `${label}: signed needs agreement.covers (what the executed agreement covers: ${COVERAGE.join(", ")})`,
    );
  const needed = new Set([...(r.phi === "receives" ? ["phi"] : []), ...(r.requires ?? [])]);
  for (const n of needed)
    if (covers.size > 0 && !covers.has(n))
      v.push(
        `${label}: the agreement does not cover \`${n}\`, which this vendor's use needs: a signed row must cover its use (confirm the addendum is executed, or leave the row pending)`,
      );
  return v;
}

/**
 * PURE: the signed rows whose agreement ends within {@link EXPIRY_WARN_DAYS} days (today included), soonest first. A warning
 * is not a violation: the gate prints it and passes, and fails the day after the end date (`validityViolations`).
 */
export function vendorAgreementWarnings(
  register: VendorRegister | undefined,
  today: Date,
): string[] {
  const due = (register?.vendors ?? []).flatMap((r) => {
    const expires = r?.agreement?.status === "signed" ? isoDate(r.agreement.expiresOn) : undefined;
    const days = expires === undefined ? Number.NaN : daysFrom(today, expires);
    return days >= 0 && days <= EXPIRY_WARN_DAYS
      ? [{ id: r.id ?? "(row)", expires: expires as string, days }]
      : [];
  });
  return due
    .sort((x, y) => x.days - y.days)
    .map(
      (d) =>
        `${d.id}: the agreement ends ${d.expires} (${d.days === 0 ? "today" : `in ${d.days} day(s)`}): renew it and record the new term before the gate fails closed`,
    );
}

/** `inventory:` claims against the §2 table. */
function claimViolations(
  r: VendorRow,
  label: string,
  inventory: ReadonlyMap<number, InventoryRow>,
): string[] {
  const v: string[] = [];
  for (const n of r.inventory ?? []) {
    const row = inventory.get(n);
    if (row === undefined) v.push(`${label}: inventory row ${n} is not in ${INVENTORY_DOC} §2`);
    else if (row.baaRequired && r.phi === "none")
      v.push(`${label}: claims inventory row ${n}, which needs a BAA, but says phi none`);
  }
  return v;
}

function registerViolations(reg: VendorRegister, today: Date): string[] {
  const v: string[] = unknownKeys(reg, REGISTER_KEYS, "register");
  if (!reg.owner || !ROLE_PATTERN.test(reg.owner))
    v.push("register needs an `owner` (a role, for example privacy-officer)");
  const reviewBy = isoDate(reg.review_by);
  if (reviewBy === undefined) v.push("register review_by must be a YYYY-MM-DD date");
  else {
    const days = daysFrom(today, reviewBy);
    if (days < 0)
      v.push(
        `register review_by ${reviewBy} passed ${-days} day(s) ago: re-examine every pending row, then renew the date`,
      );
    else if (days > MAX_REVIEW_DAYS)
      v.push(`register review_by ${reviewBy} is ${days} days out (max ${MAX_REVIEW_DAYS})`);
  }
  return v;
}

/** PURE: every input, `today` included, is injected so the tests drive each shape. */
export function checkVendorAgreements(i: CheckInputs): string[] {
  if (i.register === undefined)
    return [
      `${REGISTER_PATH} is missing or unreadable: an unreadable register must fail, never read as empty`,
    ];
  const vendors = i.register.vendors ?? [];
  if (vendors.length === 0) return [`${REGISTER_PATH} has no \`vendors\``];
  const v: string[] = registerViolations(i.register, i.today);
  if (i.rawText !== undefined && hasContactDetail(i.rawText))
    v.push(
      `${REGISTER_PATH}: contact detail (an email, URL or phone number) found in the file text, comments included: this file holds none`,
    );
  const inventory = new Map(i.inventory.map((row) => [row.number, row]));
  if (inventory.size === 0)
    v.push(
      `the integration inventory in ${INVENTORY_DOC} §2 could not be read (section missing, header or columns changed, or a malformed row): an unreadable table must fail, never read as clean`,
    );
  else if (!i.inventory.some((row) => row.baaRequired))
    v.push(
      `the integration inventory in ${INVENTORY_DOC} §2 read with no BAA-required integration: the BAA column was probably misread`,
    );

  const seen = new Set<string>();
  const claimed = new Set<number>();
  for (const [index, r] of vendors.entries()) {
    if (r === null || typeof r !== "object") {
      v.push(`(row ${index + 1}): not a mapping`);
      continue;
    }
    const label = r.id ?? `(row ${index + 1})`;
    if (r.id !== undefined && seen.has(r.id)) v.push(`${label}: duplicate id`);
    if (r.id !== undefined) seen.add(r.id);
    try {
      for (const n of r.inventory ?? []) claimed.add(n);
      v.push(
        ...shapeViolations(r, label),
        ...exposureViolations(r, label, i.fileExists),
        ...signedViolations(r, label, i.today),
        ...tenantHeldViolations(r, label, i.controlIds),
        ...validityViolations(r, label, i.today),
        ...coverageViolations(r, label),
        ...claimViolations(r, label, inventory),
      );
    } catch (e) {
      // A value of the wrong type (a number where a list belongs) is a violation, not a stack trace.
      v.push(`${label}: could not be checked, a value has the wrong type (${String(e)})`);
    }
  }
  for (const row of i.inventory)
    if (row.baaRequired && !claimed.has(row.number))
      v.push(
        `inventory row ${row.number} (${row.integration}) needs a BAA but no vendor row claims it: add a row (or add the number to \`inventory:\` of the row that covers it)`,
      );
  return v;
}

const clean = (cell: string): string => cell.replace(/[*`]/g, "").trim();

/**
 * A BAA cell that says no agreement is owed: it starts "No", "N/A" or "via <vendor>" AND never says "yes" ("n/a
 * today; Yes (vendor) later" is owed). Anything else (Yes, Conditional, Per-recipient, blank) needs a row.
 */
const noBaaOwed = (cell: string): boolean =>
  /^(?:no|n\/a|via)\b/i.test(cell) && !/\byes\b/i.test(cell);

const isSeparatorRow = (cells: readonly string[]): boolean =>
  cells.every((c) => /^:?-+:?$/.test(c));

/**
 * PURE — the §2 table of the integrations document, read by its header: the column named `BAA req'd` is found
 * there, every later row must have the header's width and a numeric first cell, and a BAA cell that is not
 * "No", "N/A" or "via ..." (or that also says "yes") counts as BAA-required: a new wording is decided by a
 * person, never skipped. Returns [] when the section or header is missing or any row is malformed (a column
 * added or moved, a `|` inside a cell, a non-numeric or repeated number), so the gate fails closed.
 */
export function parseInventory(markdown: string): InventoryRow[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^##\s+2\.\s+Integration Inventory\b/.test(l));
  if (start < 0) return [];
  const rows: InventoryRow[] = [];
  let baaColumn = -1;
  let width = -1;
  for (const raw of lines.slice(start + 1)) {
    if (/^##\s/.test(raw)) break;
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1).map(clean);
    if (cells.at(-1) === "") cells.pop();
    if (isSeparatorRow(cells)) continue;
    if (width < 0) {
      baaColumn = cells.findIndex((c) => /^BAA req/i.test(c));
      if (cells[0] !== "#" || cells[1] === undefined || baaColumn < 0) return [];
      width = cells.length;
      continue;
    }
    const number = cells[0] ?? "";
    const integration = cells[1];
    const baa = cells[baaColumn];
    if (
      cells.length !== width ||
      !/^\d+$/.test(number) ||
      integration === undefined ||
      baa === undefined
    )
      return [];
    if (rows.some((row) => row.number === Number(number))) return []; // a number twice: one of them is wrong
    rows.push({ number: Number(number), integration, baaRequired: !noBaaOwed(baa) });
  }
  return rows;
}

function readYaml<T>(text: string | undefined): T | undefined {
  return text === undefined ? undefined : ((Bun.YAML.parse(text) as T | null) ?? undefined);
}

function main(): void {
  const root = process.cwd();
  const read = (p: string): string | undefined =>
    existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : undefined;

  const violations: string[] = [];
  let register: VendorRegister | undefined;
  let controlIds = new Set<string>();
  const rawText = read(REGISTER_PATH);
  try {
    register = readYaml<VendorRegister>(rawText);
    const controls = readYaml<{ controls?: readonly { id?: string }[] }>(
      read("compliance/controls.yaml"),
    );
    controlIds = new Set((controls?.controls ?? []).flatMap((c) => (c.id ? [c.id] : [])));
  } catch (e) {
    violations.push(`${REGISTER_PATH} or compliance/controls.yaml does not parse: ${String(e)}`);
  }
  if (violations.length === 0)
    violations.push(
      ...checkVendorAgreements({
        register,
        rawText,
        inventory: parseInventory(read(INVENTORY_DOC) ?? ""),
        controlIds,
        fileExists: (p) => existsSync(join(root, p)),
        today: new Date(),
      }),
    );

  if (violations.length > 0) {
    console.error(`FAIL check-vendor-agreements: ${violations.length} violation(s)\n`);
    for (const x of violations) console.error(`  - ${x}`);
    process.exit(1);
  }
  const rows = register?.vendors ?? [];
  const count = (s: string): number => rows.filter((r) => r.agreement?.status === s).length;
  for (const w of vendorAgreementWarnings(register, new Date())) console.warn(`WARN ${w}`);
  console.log(
    `OK check-vendor-agreements: ${rows.length} vendor rows (${count("signed")} signed, ${count("pending")} pending, ${count("tenant-held")} tenant-held, ${count("not-required")} not required); every BAA-required integration in the inventory has a row`,
  );
}

if (import.meta.main) main();
