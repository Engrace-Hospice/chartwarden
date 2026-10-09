// The facts M6's typed render payloads need from M5 (patient identity) and M40 (physician name), read from the REAL
// rows the live suites seed - a `patient` row (see `seedM5Patient` in _m6-admit.ts) and the `user` row a suite
// signs as - so the document a live suite renders is drawn from real data, not from a stubbed identity.
import type { Client } from "pg";
import type { RenderSourcesPort } from "../src/modules/06-admission/render-payloads";

export function dbRenderSources(admin: Client): RenderSourcesPort {
  return {
    async patient(organizationId, patientId) {
      const { rows } = await admin.query(
        "SELECT legal_first_name, legal_last_name, mrn, dob FROM patient WHERE id=$1 AND organization_id=$2",
        [patientId, organizationId],
      );
      const r = rows[0];
      return r
        ? {
            name: `${r.legal_first_name} ${r.legal_last_name}`,
            mrn: r.mrn as string,
            dateOfBirth: r.dob ? new Date(r.dob).toISOString().slice(0, 10) : null,
          }
        : null;
    },
    async physician(_organizationId, physicianId) {
      const { rows } = await admin.query(`SELECT name FROM "user" WHERE id=$1`, [physicianId]);
      return rows[0]?.name
        ? { name: `Dr. ${rows[0].name as string}`, credentials: "MD", npi: "1234567893" }
        : null;
    },
  };
}
