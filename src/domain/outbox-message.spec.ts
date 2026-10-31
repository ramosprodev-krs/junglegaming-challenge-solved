import { describe, expect, test } from 'bun:test';
import { WagerTransactionProcessed } from './wager-transaction-processed';
import { Money } from './money';
import { OutboxMessage } from './outbox-message';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction';

const baseTime = new Date('2026-10-30T12:00:00.000Z');

const event = () => {
  const transaction = WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: baseTime,
  });

  return WagerTransactionProcessed.from(transaction, {
    eventId: 'event-1',
    correlationId: 'correlation-1',
    occurredAt: baseTime,
  });
};

describe('OutboxMessage', () => {
  test('uses the integration event id and starts due for publication', () => {
    const message = OutboxMessage.enqueue(event());

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(baseTime)).toBe(true);
  });

  test('respects the scheduled retry time and caps exponential backoff at five minutes', () => {
    const message = OutboxMessage.enqueue(event());

    message.scheduleRetry(baseTime);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(baseTime.getTime() + 1_000));
    expect(message.isDue(new Date(baseTime.getTime() + 999))).toBe(false);
    expect(message.isDue(new Date(baseTime.getTime() + 1_000))).toBe(true);

    for (let attempt = 1; attempt < 12; attempt += 1) {
      message.scheduleRetry(baseTime);
    }
    expect(message.attempts).toBe(12);
    expect(message.nextAttemptAt).toEqual(new Date(baseTime.getTime() + 5 * 60_000));
  });

  test('published messages are no longer pending or due', () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(baseTime);

    expect(message.publishedAt).toBe(baseTime);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(baseTime)).toBe(false);
  });

  test('rehydrates retry and publication state', () => {
    const message = OutboxMessage.rehydrate({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WagerTransactionProcessed',
      payload: { eventId: 'event-1' },
      occurredAt: baseTime,
      attempts: 3,
      nextAttemptAt: new Date(baseTime.getTime() + 8_000),
    });

    expect(message.attempts).toBe(3);
    expect(message.isDue(baseTime)).toBe(false);
    expect(message.isDue(new Date(baseTime.getTime() + 8_000))).toBe(true);
  });
});
