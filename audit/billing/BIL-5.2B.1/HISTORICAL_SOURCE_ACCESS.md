# Historical source access

M23's `getSubmissionForInvestigation` reads the source-owned attempt under the authenticated organization/provider scope without requiring its current dispatch state to remain `in_doubt`. The existing in-doubt worklist method still filters to `in_doubt`.

M41's equivalent reads the source-owned submission and joined claim under organization/provider scope, then applies the existing patient-caseload authorization. Its in-doubt worklist remains state-filtered.

Opening a new case still requires current `in_doubt`. Reading or maintaining an existing case revalidates the source through the owner reader and verifies the claim/provider association against the persisted reference. Missing or inaccessible sources return not found; investigation rows cannot override revoked access.
