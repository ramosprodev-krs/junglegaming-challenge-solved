import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';
import { WalletBalanceChanged } from './wallet-balance-changed';
import { LedgerDirection } from './wallet-ledger-entry';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference';
import { WagerTransactionProcessed } from './wager-transaction-processed';
import { WagerTransactionRejected } from './wager-transaction-rejected';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction';

const occurredAt = new Date('2026-10-30T12:34:56.789Z');
const context = {
  eventId: 'event-1',
  correlationId: 'correlation-1',
  causationId: 'cause-1',
  occurredAt,
};

const transaction = (kind = WagerTransactionKind.Bet) =>
  WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({ amount: '25.50', currency: 'BRL' }),
    referenceExternalTransactionId: kind === WagerTransactionKind.Refund ? 'bet-1' : undefined,
    createdAt: occurredAt,
  });

describe('Integration events', () => {
  test('serializes a processed event with MoneyProps and an ISO-8601 timestamp', () => {
    const serialized = WagerTransactionProcessed.from(transaction(), context).toJSON();

    expect(serialized).toMatchObject({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      occurredAt: '2026-10-30T12:34:56.789Z',
      version: 1,
      data: {
        money: { amount: '25.50', currency: 'BRL' },
      },
    });
    expect(typeof serialized.data.money.amount).toBe('string');
    expect(JSON.parse(JSON.stringify(serialized)).occurredAt).toBe('2026-10-30T12:34:56.789Z');
  });

  test('rejected and pending-reference events carry their machine-readable context', () => {
    const rejected = transaction();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(WagerTransactionRejected.from(rejected, context).toJSON().data.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    const pending = transaction(WagerTransactionKind.Refund);
    pending.markPendingReference();
    expect(
      WagerTransactionPendingReference.from(pending, context).toJSON().data
        .referenceExternalTransactionId,
    ).toBe('bet-1');
  });

  test('wallet balance event serializes all money values as decimal strings', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      openingTransactionId: 'opening-1',
      openingEntryId: 'entry-opening-1',
      at: occurredAt,
    });
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'transaction-1',
      money: Money.from({ amount: '25.50', currency: 'BRL' }),
      at: occurredAt,
    });
    const data = WalletBalanceChanged.from(wallet, entry, context).toJSON().data;

    expect(data.direction).toBe(LedgerDirection.Debit);
    expect(data.money).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(data.balanceAfter).toEqual({ amount: '74.50', currency: 'BRL' });
    expect(data.walletVersion).toBe(2);
  });
});
