import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './domain-error';
import { FailureCode } from './failure-code';
import { Money } from './money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import { LedgerDirection } from './wallet-ledger-entry';

const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const create = (
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
  amount = '10.00',
) =>
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
    money: money(amount),
    referenceExternalTransactionId,
    createdAt: new Date('2026-10-30T12:00:00.000Z'),
  });

describe('WagerTransaction', () => {
  test('requires a provider reference for REFUND and ROLLBACK', () => {
    expect(() => create(WagerTransactionKind.Refund)).toThrow(InvalidWagerTransactionError);
    expect(() => create(WagerTransactionKind.Rollback)).toThrow(InvalidWagerTransactionError);
    expect(create(WagerTransactionKind.Refund, 'bet-1').status).toBe(WagerTransactionStatus.Pending);
  });

  test('allows a zero-valued LOSS and rejects zero-valued balance movements', () => {
    expect(() => create(WagerTransactionKind.Loss, undefined, '0.00')).not.toThrow();
    expect(() => create(WagerTransactionKind.Bet, undefined, '0.00')).toThrow(InvalidWagerTransactionError);
  });

  test('has terminal states and rejects a second transition', () => {
    const transaction = create(WagerTransactionKind.Bet);
    transaction.markProcessed(undefined, new Date());
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
  });

  test('ROLLBACK reverses the reference ledger direction', () => {
    const bet = create(WagerTransactionKind.Bet);
    const rollback = create(WagerTransactionKind.Rollback, 'bet-1');
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = create(WagerTransactionKind.Win);
    expect(create(WagerTransactionKind.Rollback, 'win-1').ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test('exposes reference, balance and payload queries', () => {
    const bet = create(WagerTransactionKind.Bet);
    const refund = create(WagerTransactionKind.Refund, 'bet-1');
    const loss = create(WagerTransactionKind.Loss);

    expect(refund.requiresReference()).toBe(true);
    expect(bet.requiresReference()).toBe(false);
    expect(bet.affectsBalance()).toBe(true);
    expect(loss.affectsBalance()).toBe(false);
    expect(bet.matchesPayload('a'.repeat(64))).toBe(true);
    expect(bet.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('supports PENDING_REFERENCE retries, then terminal rejection', () => {
    const transaction = create(WagerTransactionKind.Refund, 'bet-1');
    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.isTerminal()).toBe(false);

    transaction.markPendingReference();
    transaction.reject(FailureCode.ReferenceNotFound);
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('FAILED is terminal and retains its failure code', () => {
    const transaction = create(WagerTransactionKind.Bet);
    transaction.fail(FailureCode.InternalError);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.InternalError);
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );
  });
});
