# No-posting guarantees

`createClaimMdEraResolver` depends on the protected source store, read-only M1/M23/M41 evidence readers, parser, and resolution persistence. Its dependency graph contains no M25 ingest service, outbox publisher, payment writer, AR writer, denial poster, or claim-state writer. The resolution worker only loads captured inbox IDs and calls this resolver.

The code does not call `receiveAdvice` or `postAdvice`, and does not emit `m25.edi.835_received`. It does not call the BIL-1.4 staging operation. It writes only central encrypted ownership decision/history rows. Existing manual, SFTP and per-provider M25 workflows are not changed. Enabling ownership resolution does not enable capture, staging, or posting.

Verification is static plus focused unit/parser tests; no private database integration test has yet proven role permissions or absence of side effects under actual application roles. Automatic financial posting remains prohibited.
