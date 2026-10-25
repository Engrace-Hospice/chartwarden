// M36 WP 6.7 (ADR-0099 D2, D10, D12, D15) - "may this person reach the family thread right now" is ONE SQL definition: the function
// `message_family_person(patient_caregiver_id)` of migration 1235. It is embedded in the statement that resolves the bearer and in the staff screens that
// show the reason, so what staff are told and what the contact may do cannot disagree. The neighbouring modules' tables (M5 patient / caregiver / privacy
// flags, M16 bereavement plan, M39 consent) are read INSIDE that function, never named by M36 application code (arch:tables). The function is SECURITY
// INVOKER (the caller's org RLS applies), compares organization_id to app.org_id, and judges every instant on the database clock.
//
// FAIL CLOSED: a missing patient, caregiver or consent row is "not eligible"; a patient whose privacy-flag snapshot is invalidated (being recomputed) or
// carries the `sud` flag is Part 2 restricted (no Part 2 release naming a family contact exists in this build); the legal-representative (DPOA) route is
// not honoured because nothing proves the consent names THIS caregiver.
import { sql } from "drizzle-orm";

/**
 * The person behind a thread link. Alias `fp` exposes: patient_id, patient_caregiver_id, patient_name, caregiver_name, relationship,
 * is_legal_representative, provider_entity_id, location_id, reason (`ok` or the first cause), mode (`standard` | `bereavement`) and language.
 * Alias `c` is the thread link (message_family_contact), which the caller names first.
 */
export const contactPersonJoin = sql`CROSS JOIN LATERAL message_family_person(c.patient_caregiver_id) fp`;
