# Claim and payment reconciliation

This increment does not join M23/M24/M41 claim obligations to M25 payments. Such reconciliation requires owner-controlled stable identity and historical attempt semantics across each source. It reports M25 BPR, CLP, CAS and PLB facts separately. It does not treat payer-reported values as posted amounts, allocate PLB to claims, or count retries as distinct claims. A fully posted-advice CLP total is distinct from received CLP totals; partial-posted advice is separately counted.

An authenticated private-PostgreSQL test exercises the M25 report against persisted synthetic remittance data and verifies provider/org scoping and read nonmutation. It is not an M41-to-M25 reconciliation test.
