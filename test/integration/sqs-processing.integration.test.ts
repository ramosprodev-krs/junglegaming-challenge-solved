import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { WagerProcessorService } from '../../src/application/wager-processor.service';
import { SqsService } from '../../src/infrastructure/sqs.service';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';

const enabled = Boolean(process.env.DATABASE_URL && process.env.SQS_ENDPOINT_URL);

describe('SQS redelivery integration', () => {
  if (!enabled) {
    test.skip('set DATABASE_URL and SQS_ENDPOINT_URL to run LocalStack integration tests', () => {});
    return;
  }

  let app: INestApplicationContext;
  let processor: WagerProcessorService;
  let queues: SqsService;
  let client: SQSClient;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    processor = app.get(WagerProcessorService);
    queues = app.get(SqsService);
    client = new SQSClient({
      endpoint: process.env.SQS_ENDPOINT_URL,
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }, 30_000);

  afterAll(async () => {
    client?.destroy();
    await app?.close();
  });

  test('processes repeated SQS deliveries without duplicating a debit', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await processor.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const externalTransactionId = `sqs-${crypto.randomUUID()}`;
    const transaction = {
      providerId: 'sqs-integration-provider',
      externalTransactionId,
      idempotencyKey: `sqs:${externalTransactionId}`,
      playerId,
      walletId: wallet.id,
      roundId: 'sqs-round',
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };

    await Promise.all([0, 1].map((attempt) =>
      client.send(new SendMessageCommand({
        QueueUrl: queues.transactionQueueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: `${externalTransactionId}-${attempt}`,
        MessageBody: JSON.stringify({
          messageId: `sqs-test-${externalTransactionId}-${attempt}`,
          type: 'WagerTransactionRequested',
          data: transaction,
        }),
      })),
    ));

    let status = 'PENDING';
    for (let attempt = 0; attempt < 30 && status !== 'PROCESSED'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const stored = await processor.getProviderTransaction(
          transaction.providerId,
          externalTransactionId,
        );
        status = String(stored.status);
      } catch {
      }
    }
    let replayCount = 0;
    for (let attempt = 0; attempt < 30 && replayCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const metrics = await processor.metrics();
      replayCount = Number(metrics.match(/wager_idempotent_replays_total (\d+)/)?.[1] ?? 0);
    }

    const ledger = await processor.getLedger(wallet.id, undefined, '100');
    const updatedWallet = await processor.getWallet(wallet.id);
    expect(status).toBe('PROCESSED');
    expect(replayCount).toBeGreaterThan(0);
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect(updatedWallet.balance.amount).toBe('70.00');
    expect((await processor.reconcile(wallet.id)).consistent).toBe(true);
  }, 30_000);
});
