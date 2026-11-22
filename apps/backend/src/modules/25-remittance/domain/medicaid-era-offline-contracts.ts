/** Reference-only contract plans. They describe retrieval inputs and never execute HTTP/SFTP. */
export type OfflineEraRetrievalPlan =
  | {
      readonly vendor: "stedi";
      readonly mode: "test";
      readonly method: "GET";
      readonly resource: "/change/medicalnetwork/reports/v2/{transactionId}/835";
      readonly transactionId: string;
      readonly network: "disabled";
    }
  | {
      readonly vendor: "claimmd";
      readonly mode: "test";
      readonly firstStep: { readonly service: "eralist"; readonly cursor: string | null };
      readonly detailStep: { readonly service: "era835"; readonly eraId: string } | null;
      readonly accountReference: string;
      readonly network: "disabled";
    };

/** Test-mode Stedi event identity maps to a documented report resource; production-mode events fail closed. */
export function planStediTestEraRetrieval(input: {
  readonly applicationMode: "test" | "production";
  readonly transactionId: string;
}): OfflineEraRetrievalPlan | null {
  if (
    input.applicationMode !== "test" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.transactionId)
  )
    return null;
  return {
    vendor: "stedi",
    mode: "test",
    method: "GET",
    resource: "/change/medicalnetwork/reports/v2/{transactionId}/835",
    transactionId: input.transactionId,
    network: "disabled",
  };
}

/** Claim.MD's ERAID cursor/detail sequence, scoped to a synthetic account reference and without credentials. */
export function planClaimMdTestEraRetrieval(input: {
  readonly accountReference: string;
  readonly lastEraId: string | null;
  readonly returnedEraId: string | null;
}): OfflineEraRetrievalPlan | null {
  if (!input.accountReference.startsWith("synthetic:") || input.accountReference.length <= 10)
    return null;
  if (input.lastEraId !== null && !/^\d+$/.test(input.lastEraId)) return null;
  if (input.returnedEraId !== null && !/^\d+$/.test(input.returnedEraId)) return null;
  return {
    vendor: "claimmd",
    mode: "test",
    firstStep: { service: "eralist", cursor: input.lastEraId },
    detailStep:
      input.returnedEraId === null ? null : { service: "era835", eraId: input.returnedEraId },
    accountReference: input.accountReference,
    network: "disabled",
  };
}
