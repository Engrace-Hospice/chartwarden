# Legacy manual and pull-path regression

The private runner executes the existing M25 golden 835 suite through the real in-process X12 parser, `receiveAdvice`, `postAdvice`, M23 claim matching and the real outbox dispatcher under the restricted application role. This exercises the supported manual legacy financial path after the BIL-3 posting-core changes.

The runner also executes `m25-clearinghouse-pull.test.ts` with the in-memory clearinghouse transport. It verifies cursor resume, duplicate file handling and receive handoff without making a live clearinghouse/SFTP connection. A live SFTP endpoint is not part of this test environment and was not activated.

The Claim.MD changes do not route through `receiveAdvice`; the legacy workflow and its posting semantics are preserved.
