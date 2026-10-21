// @chartwarden/db — M22 Document Management schema barrel (§3.3, 17 tables). Re-exported from the
// central schema barrel (../index.ts). Ordering follows FK dependency: document → version/tag/
// access-log/legal-hold; form_template → version → overlay/fill; intake_upload_batch →
// classified_page → extraction_job → candidate/discrepancy/review → decision → provenance.
export * from "./document";
export * from "./document-upload";
export * from "./document-version";
export * from "./document-tag";
export * from "./document-access-log";
export * from "./document-legal-hold";
export * from "./form-template";
export * from "./form-template-version";
export * from "./tenant-template-overlay";
export * from "./form-fill";
export * from "./intake-upload-batch";
export * from "./intake-batch-relink";
export * from "./intake-records-request";
export * from "./intake-records-request-fax";
export * from "./classified-page";
export * from "./extraction-job";
export * from "./extraction-candidate";
export * from "./extraction-discrepancy";
export * from "./extraction-review";
export * from "./extraction-decision";
export * from "./extraction-provenance";
