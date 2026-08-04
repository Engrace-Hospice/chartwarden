// Planted violation (TASK-050D): deliberately stale — does not match what openapi-typescript
// generates from the fixture's docs/api/openapi.json, simulating a schema.ts nobody regenerated
// after an openapi.json change.
export type paths = Record<string, never>;
