/**
 * Audit-only reproduction for the M5 -> M23 payer transition boundary.
 *
 * Run only against the disposable private audit database. The script inserts
 * synthetic rows, exercises the production readers as chartwarden_app, prints
 * non-PHI identifiers/results, and removes the synthetic organization.
 */
import { createDbClient } from "../../../packages/db/src/index";
import { Client } from "pg";
import { appRoleConnectionString } from "../../../apps/backend/__tests__/_live-app-role";
import { buildPatientCoverageReader } from "../../../apps/backend/src/modules/05-patient/coverage-reader";
import { buildM23PatientPayerAdapter } from "../../../apps/backend/src/modules/23-billing-medicare/services/claim-assembly-seam-adapters";

const connectionString = process.env.CHARTWARDEN_TEST_DATABASE_URL;
if (!connectionString || !connectionString.includes("audit_billing")) {
  throw new Error("Refusing to run: CHARTWARDEN_TEST_DATABASE_URL must name audit_billing");
}

const orgId = "8a8a8a8a-1111-4111-8111-111111111111";
const patientId = "8a8a8a8a-2222-4222-8222-222222222222";
const medicarePayerId = "8a8a8a8a-3333-4333-8333-333333333333";
const commercialPayerId = "8a8a8a8a-4444-4444-8444-444444444444";
const transitionDate = "2026-01-15";

const admin = new Client({ connectionString });
await admin.connect();

async function cleanSyntheticRows(): Promise<void> {
  // Superuser-only teardown in the disposable database: suppress audit triggers so deleting the
  // synthetic parent does not create a new audit row that immediately reintroduces the FK edge.
  await admin.query("SET session_replication_role = replica");
  try {
    await admin.query("DELETE FROM audit_event WHERE organization_id = $1", [orgId]);
    await admin.query("DELETE FROM patient_payer WHERE organization_id = $1", [orgId]);
    await admin.query("DELETE FROM patient WHERE organization_id = $1", [orgId]);
    await admin.query("DELETE FROM organization WHERE id = $1", [orgId]);
  } finally {
    await admin.query("SET session_replication_role = origin");
  }
}

let handle: ReturnType<typeof createDbClient> | undefined;
try {
  await cleanSyntheticRows();
  await admin.query(
    "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'audit-payer-transition','Audit Payer Transition','Audit Payer Transition')",
    [orgId],
  );
  await admin.query(
    `INSERT INTO patient
       (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
     VALUES ($1,$2,'AUDIT-MRN','Synthetic','Patient','1950-01-01','female','active')`,
    [patientId, orgId],
  );
  await admin.query(
    `INSERT INTO patient_payer
       (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from, effective_to)
     VALUES
       ($1,$2,$3,1,'medicare_ffs','AUDIT-MBI','2026-01-01',$5),
       ($1,$2,$4,1,'commercial','AUDIT-COMMERCIAL','2026-01-15',NULL)`,
    [patientId, orgId, medicarePayerId, commercialPayerId, transitionDate],
  );

  const appConnectionString = await appRoleConnectionString(admin, connectionString);
  handle = createDbClient({ connectionString: appConnectionString });
  const coverage = buildPatientCoverageReader(handle.db);
  const adapter = buildM23PatientPayerAdapter(() => coverage);

  const [medicareAtTransition, commercialAtTransition, m23Resolution] = await Promise.all([
    coverage.activeCoverageOfKind({
      organizationId: orgId,
      patientId,
      coverageKind: "medicare_ffs",
      onDate: transitionDate,
    }),
    coverage.activeCoverageOfKind({
      organizationId: orgId,
      patientId,
      coverageKind: "commercial",
      onDate: transitionDate,
    }),
    adapter.medicarePrimaryForRange(orgId, patientId, {
      from: transitionDate,
      to: transitionDate,
    }),
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        transitionDate,
        medicareAtTransition: medicareAtTransition
          ? { rank: medicareAtTransition.rank, coverageKind: medicareAtTransition.coverageKind }
          : null,
        commercialAtTransition: commercialAtTransition
          ? { rank: commercialAtTransition.rank, coverageKind: commercialAtTransition.coverageKind }
          : null,
        m23Resolution: m23Resolution
          ? {
              medicarePrimary: m23Resolution.medicarePrimary,
              medicareAdvantageEnrollee: m23Resolution.medicareAdvantageEnrollee ?? false,
            }
          : null,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (handle) await handle.close();
  await cleanSyntheticRows();
  await admin.end();
}
