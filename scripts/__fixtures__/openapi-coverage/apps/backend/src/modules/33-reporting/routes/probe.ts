// Planted violation: a route that publishes NO request contract. The real
// enrichments registry (statically imported by the gate) has no entry for this
// path, so the module's deficit exceeds its implied baseline floor of 0.
export function probe(app: any) {
  app.post("/api/v1/__fixture/unenriched", async () => ({}));
}
