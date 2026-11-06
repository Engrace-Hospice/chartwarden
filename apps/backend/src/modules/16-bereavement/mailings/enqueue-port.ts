// apps/backend/src/modules/16-bereavement/mailings/enqueue-port.ts — ADR-0109 D10: how a `generate` request reaches the `m16-mailing-generate` worker.
//
// The job names a run and the run version that claimed it: ids only. It carries no recipient, name or address (the worker reads the items and decrypts
// the addresses itself, in-process, and they never ride the queue or the outbox).

export interface MailingGenerateJob {
  readonly organizationId: string;
  readonly runId: string;
  /** The run's version at the draft/failed -> generating claim; a retry after a failure claims a NEW version, so the job ids never collide. */
  readonly version: number;
}

export interface MailingGenerateEnqueuePort {
  enqueue(job: MailingGenerateJob): Promise<void>;
}

/** The BullMQ job id of a generate request (also what makes a re-enqueue by the sweep idempotent). */
export const mailingGenerateJobId = (job: MailingGenerateJob): string =>
  `m16-mailing-generate:${job.runId}:${job.version}`;
