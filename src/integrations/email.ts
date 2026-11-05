import type { OutboundEmail } from '../domain/types.ts';
import type { Collection } from '../store/db.ts';

/** Port to the mail system. The prototype records messages in an outbox table. */
export interface EmailGateway {
  send(msg: OutboundEmail): OutboundEmail;
  list(): OutboundEmail[];
}

export class OutboxEmailGateway implements EmailGateway {
  private outbox: Collection<OutboundEmail>;

  constructor(outbox: Collection<OutboundEmail>) {
    this.outbox = outbox;
  }

  send(msg: OutboundEmail): OutboundEmail {
    // Idempotent per task: a retried send does not produce a second email.
    const prior = this.outbox.find((m) => m.taskId === msg.taskId);
    if (prior.length) return prior[0];
    return this.outbox.insert(msg);
  }

  list(): OutboundEmail[] {
    return this.outbox.all().reverse();
  }
}
