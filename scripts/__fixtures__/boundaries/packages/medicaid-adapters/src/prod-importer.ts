// FIXTURE — intentional violation: production code imports the test-only synthetic-fixture subpath.
// Proves dependency-cruiser goes RED (medicaid-adapters-testing-only-from-tests).
import { SYNTHETIC_FIXTURE } from "./testing";
export const fromProduction = SYNTHETIC_FIXTURE;
