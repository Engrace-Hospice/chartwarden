# Security and financial isolation

Tenant detail is loaded under `withOrgContext`, `remittance.read`, and provider scope. Central reads occur only after that stage read and exact ownership binding; query parameters cannot override organization. Sensitive data remains allowlisted by the existing detail projection. No `receiveAdvice`, `postAdvice`, `m25.edi.835_received`, ledger, adjustment, balance, or posting-outbox path was added or invoked. The review-history job uses the existing audited platform context and dedicated read-only history operation.
