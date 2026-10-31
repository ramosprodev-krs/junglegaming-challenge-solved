import { createHash } from 'node:crypto';
import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { MikroORM, type QueryResult } from '@mikro-orm/core';
import { WagerProcessorService } from '../application/wager-processor.service';
import { SqsService } from './sqs.service';

type DbRow = Record<string, unknown>;

@Injectable()
export class WorkersService implements OnModuleInit, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  private active?: Promise<void>;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsService,
    private readonly processor: WagerProcessorService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.polling || this.stopped) return;
      this.polling = true;
      this.active = this.runCycle()
        .catch((error: unknown) => {
          console.error(JSON.stringify({
            event: 'worker_cycle_failed',
            error: error instanceof Error ? error.message : 'unknown',
          }));
        })
        .finally(() => {
          this.polling = false;
          this.active = undefined;
        });
    }, 500);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  private async runCycle(): Promise<void> {
    if (process.env.WORKERS_ENABLED === 'false') return;
    await Promise.all([
      this.consumeOne(),
      this.publishOutboxBatch(),
      this.processor.processPendingReferences(),
    ]);
  }

  private async consumeOne(): Promise<void> {
    const response = await this.sqs.receiveTransaction();
    for (const message of response.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      try {
        const body: unknown = JSON.parse(message.Body);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new TypeError('SQS transaction message must be a JSON object');
        }
        const envelope = body as Record<string, unknown>;
        if (envelope.type && envelope.type !== 'WagerTransactionRequested') {
          throw new TypeError('Unsupported SQS message type');
        }
        const data = envelope.data ?? body;
        const envelopeMessageId = typeof envelope.messageId === 'string' ? envelope.messageId : '';
        const businessId = message.MessageId ?? envelopeMessageId;
        if (!businessId) throw new TypeError('SQS message id is missing');
        await this.processor.submitWager(data, {
          messageId: businessId,
          payloadHash: createHash('sha256').update(message.Body).digest('hex'),
        });
        await this.sqs.acknowledge(message.ReceiptHandle);
      } catch (error) {
        console.error(JSON.stringify({
          event: 'sqs_transaction_retry',
          messageId: message.MessageId,
          receiveCount: message.Attributes?.ApproximateReceiveCount,
          error: error instanceof Error ? error.message : 'unknown',
        }));
      }
    }
  }

  private async publishOutboxBatch(): Promise<void> {
    await this.orm.em.transactional(async (em) => {
      const due = await this.query(
        em,
        `SELECT id, aggregate_id, payload::text AS payload, attempts
         FROM outbox_messages
         WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY occurred_at, id
         LIMIT 20 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of due) {
        try {
          await this.sqs.sendEvent(String(row.aggregate_id), String(row.id), String(row.payload));
          await this.query(
            em,
            'UPDATE outbox_messages SET published_at = now(), next_attempt_at = NULL WHERE id = ?',
            [row.id],
          );
        } catch (error) {
          const attempts = Number(row.attempts) + 1;
          const delay = Math.min(2 ** attempts, 300);
          await this.query(
            em,
            `UPDATE outbox_messages SET attempts = ?,
             next_attempt_at = now() + (? * interval '1 second') WHERE id = ?`,
            [attempts, delay, row.id],
          );
          await this.query(
            em,
            `INSERT INTO operational_counters (name, value) VALUES ('worker_retries', 1)
             ON CONFLICT (name) DO UPDATE SET value = operational_counters.value + 1, updated_at = now()`,
          );
          console.error(JSON.stringify({
            event: 'outbox_publish_retry',
            eventId: row.id,
            attempts,
            error: error instanceof Error ? error.message : 'unknown',
          }));
        }
      }
    });
  }

  private async query(em: typeof this.orm.em, sql: string, params: unknown[] = []): Promise<DbRow[]> {
    const result = await em.getConnection().execute<DbRow>(
      sql,
      params,
      'all',
      em.getTransactionContext(),
    );
    if (Array.isArray(result)) return result as DbRow[];
    return ((result as QueryResult<DbRow>).rows ?? []) as DbRow[];
  }
}
