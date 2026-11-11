# Tenant and provider financial security

The endpoint requires `remittance.read`; organization is taken from authenticated request context. Provider filtering uses the existing authorized provider scope and the M25 owner query executes under org RLS context. The private suite seeds a second organization and an out-of-scope provider and asserts their values are absent from the authorized response. The route exposes aggregate financial facts only, no raw ERA, patient/member identifiers, central inbox data, or account credentials.

No M23/M24/M41 private-table joins were added. Their existing source-owned authorization remains unchanged. This report does not claim M41 caseload aggregation because no M41 claims aggregation is implemented here.
