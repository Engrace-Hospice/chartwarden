// @wardenx/quality — NIST 800-66r2 SRA template structure (M30-P2a). Pure const, IO-free.
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

/**
 * The NIST SP 800-66 Rev. 2 SRA template: the HIPAA Security Rule safeguard families and their
 * assessable control sections. Version-pinned and frozen — a tenant cycle assesses exactly these
 * controls; tenant-specific findings attach to a section id.
 */
export const NIST_800_66_R2_TEMPLATE: SraTemplate = {
  version: "nist_800_66_r2",
  families: [
    {
      id: "administrative",
      category: "admin",
      title: "Administrative Safeguards",
      citation: "45 CFR §164.308",
      sections: [
        {
          id: "admin.security_management_process",
          title:
            "Security Management Process (risk analysis, risk management, sanction policy, info-system activity review)",
          citation: "45 CFR §164.308(a)(1)",
          required: true,
        },
        {
          id: "admin.assigned_security_responsibility",
          title: "Assigned Security Responsibility",
          citation: "45 CFR §164.308(a)(2)",
          required: true,
        },
        {
          id: "admin.workforce_security",
          title: "Workforce Security (authorization, clearance, termination procedures)",
          citation: "45 CFR §164.308(a)(3)",
          required: false,
        },
        {
          id: "admin.information_access_management",
          title:
            "Information Access Management (access authorization, establishment & modification)",
          citation: "45 CFR §164.308(a)(4)",
          required: false,
        },
        {
          id: "admin.security_awareness_training",
          title:
            "Security Awareness and Training (reminders, malicious-software protection, log-in monitoring, password management)",
          citation: "45 CFR §164.308(a)(5)",
          required: false,
        },
        {
          id: "admin.security_incident_procedures",
          title: "Security Incident Procedures (response and reporting)",
          citation: "45 CFR §164.308(a)(6)",
          required: true,
        },
        {
          id: "admin.contingency_plan",
          title:
            "Contingency Plan (data backup, disaster recovery, emergency-mode operation, testing, criticality analysis)",
          citation: "45 CFR §164.308(a)(7)",
          required: true,
        },
        {
          id: "admin.evaluation",
          title: "Evaluation (periodic technical & non-technical evaluation)",
          citation: "45 CFR §164.308(a)(8)",
          required: true,
        },
      ],
    },
    {
      id: "physical",
      category: "physical",
      title: "Physical Safeguards",
      citation: "45 CFR §164.310",
      sections: [
        {
          id: "physical.facility_access_controls",
          title:
            "Facility Access Controls (contingency operations, facility security plan, access control & validation, maintenance records)",
          citation: "45 CFR §164.310(a)(1)",
          required: false,
        },
        {
          id: "physical.workstation_use",
          title: "Workstation Use",
          citation: "45 CFR §164.310(b)",
          required: true,
        },
        {
          id: "physical.workstation_security",
          title: "Workstation Security",
          citation: "45 CFR §164.310(c)",
          required: true,
        },
        {
          id: "physical.device_media_controls",
          title:
            "Device and Media Controls (disposal, media re-use, accountability, data backup & storage)",
          citation: "45 CFR §164.310(d)(1)",
          required: false,
        },
      ],
    },
    {
      id: "technical",
      category: "technical",
      title: "Technical Safeguards",
      citation: "45 CFR §164.312",
      sections: [
        {
          id: "technical.access_control",
          title:
            "Access Control (unique user identification, emergency access, automatic logoff, encryption & decryption)",
          citation: "45 CFR §164.312(a)(1)",
          required: false,
        },
        {
          id: "technical.audit_controls",
          title: "Audit Controls",
          citation: "45 CFR §164.312(b)",
          required: true,
        },
        {
          id: "technical.integrity",
          title: "Integrity (mechanism to authenticate ePHI)",
          citation: "45 CFR §164.312(c)(1)",
          required: false,
        },
        {
          id: "technical.person_entity_authentication",
          title: "Person or Entity Authentication",
          citation: "45 CFR §164.312(d)",
          required: true,
        },
        {
          id: "technical.transmission_security",
          title: "Transmission Security (integrity controls, encryption)",
          citation: "45 CFR §164.312(e)(1)",
          required: false,
        },
      ],
    },
    {
      id: "organizational",
      category: "admin",
      title: "Organizational Requirements",
      citation: "45 CFR §164.314",
      sections: [
        {
          id: "organizational.business_associate_contracts",
          title: "Business Associate Contracts and Other Arrangements",
          citation: "45 CFR §164.314(a)",
          required: true,
        },
        {
          id: "organizational.group_health_plan_requirements",
          title: "Requirements for Group Health Plans",
          citation: "45 CFR §164.314(b)",
          required: true,
        },
      ],
    },
    {
      id: "policies_procedures",
      category: "admin",
      title: "Policies, Procedures, and Documentation Requirements",
      citation: "45 CFR §164.316",
      sections: [
        {
          id: "policies.policies_and_procedures",
          title: "Policies and Procedures",
          citation: "45 CFR §164.316(a)",
          required: true,
        },
        {
          id: "policies.documentation",
          title: "Documentation (time limit, availability, updates)",
          citation: "45 CFR §164.316(b)(1)",
          required: true,
        },
      ],
    },
  ],
};
