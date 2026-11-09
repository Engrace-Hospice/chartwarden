// @chartwarden/quality — NIST 800-66r2 SRA template structure (M30-P2a). Pure const, IO-free.
//
// `sra_cycle.template_version` defaults to `nist_800_66_r2`. NIST SP 800-66 Rev. 2 frames the HIPAA
// Security Rule risk assessment around the Rule's safeguard standards (45 CFR §164.308 Administrative,
// §164.310 Physical, §164.312 Technical, §164.314 Organizational, §164.316 Policies & Procedures). This
// module is the pure, version-pinned scaffold a new cycle enumerates its assessable controls from — each
// standard becomes one or more assessable sections a finding can be raised against. No IO; the route
// projects assessable controls from this const when it opens a cycle.
//
// `affectedAssetCategory` on `sra_finding` is one of `admin | physical | technical`; the Organizational
// and Policies families map to `admin` for that column (they are administrative in nature).

/** The asset category a family rolls up to for the `sra_finding.affected_asset_category` column. */
export type SraAssetCategory = "admin" | "physical" | "technical";

/** One assessable control section under a family (an HIPAA Security Rule standard or implementation spec). */
export interface SraTemplateSection {
  /** Stable section id (used to anchor a finding to a control). */
  readonly id: string;
  /** Human-readable control title. */
  readonly title: string;
  /** The 45 CFR citation the section assesses. */
  readonly citation: string;
  /** Whether the implementation specification is "Required" (vs. "Addressable") under the Rule. */
  readonly required: boolean;
}

/** One HIPAA Security Rule safeguard family (a NIST 800-66r2 control family). */
export interface SraTemplateFamily {
  /** Stable family id. */
  readonly id: string;
  /** The asset category findings under this family roll up to. */
  readonly category: SraAssetCategory;
  /** Human-readable family title. */
  readonly title: string;
  /** The 45 CFR citation anchoring the family. */
  readonly citation: string;
  /** The assessable control sections under the family. */
  readonly sections: ReadonlyArray<SraTemplateSection>;
}

/** The version-pinned NIST 800-66r2 template (matches `sra_cycle.template_version`). */
export interface SraTemplate {
  readonly version: "nist_800_66_r2";
  readonly families: ReadonlyArray<SraTemplateFamily>;
}
