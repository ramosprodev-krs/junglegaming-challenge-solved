import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MikroORM, type QueryResult } from '@mikro-orm/core';
import { FailureCode } from '../domain/failure-code';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { LedgerDirection } from '../domain/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { WalletBalanceChanged } from '../domain/wallet-balance-changed';
import { WagerTransactionProcessed } from '../domain/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../domain/wager-transaction-pending-reference';
import { OutboxMessage } from '../domain/outbox-message';
import { InboxMessage } from '../domain/inbox-message';
import { IntegrationEvent } from '../domain/integration-event';

type DbRow = Record<string, unknown>;
type WagerInput = {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
};
type WagerResult = {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
};

const CONSUMER_NAME = 'wager-processor';
const MAX_REFERENCE_ATTEMPTS = 10;

@Injectable()
export class WagerProcessorService {
  constructor(private readonly orm: MikroORM) {}

  async createWallet(playerId: string, initialBalance: { amount: string; currency: string }) {
    if (!playerId?.trim()) throw new TypeError('playerId is required');
    const money = Money.from(initialBalance);
    const walletId = randomUUID();
    const openingTransactionId = randomUUID();
    const openingEntryId = randomUUID();
    const now = new Date();

    try {
      return await this.orm.em.transactional(async (em) => {
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId,
          initialBalance: money,
          openingTransactionId,
          openingEntryId,
          at: now,
        });
        await this.query(
          em,
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toJSON().amount, wallet.version, now, now],
        );
        if (openingEntry) {
          await this.query(
            em,
            `INSERT INTO wager_transactions
             (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
              player_id, round_id, game_id, kind, amount, currency, status, processed_at,
              balance_snapshot, created_at)
             VALUES (?, '__internal__', ?, ?, ?, ?, ?, '__opening__', '__opening__',
                     'OPENING', ?, ?, 'PROCESSED', ?, ?, ?)`,
            [
              openingTransactionId,
              openingTransactionId,
              `opening:${walletId}`,
              createHash('sha256').update(walletId).digest('hex'),
              walletId,
              playerId,
              money.toJSON().amount,
              money.currency,
              now,
              money.toJSON().amount,
              now,
            ],
          );
          await this.insertLedger(em, openingEntry);
        }
        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({ code: 'WALLET_ALREADY_EXISTS', message: 'Wallet already exists for player and currency' });
      }
      throw error;
    }
  }

  async submitWager(inputValue: unknown, inbox?: { messageId: string; payloadHash: string }) {
    const input = this.validateInput(inputValue);
    const payloadHash = this.hashInput(input);
    const candidateId = randomUUID();
    const createdAt = new Date();
    WagerTransaction.create({
      ...input,
      id: candidateId,
      payloadHash,
      money: Money.from(input.money),
      createdAt,
    });
    const process = () => this.orm.em.transactional(async (em) => {
      if (inbox) {
        const inboxMessage = InboxMessage.receive({
          messageId: inbox.messageId,
          consumerName: CONSUMER_NAME,
          payloadHash: inbox.payloadHash,
          receivedAt: new Date(),
        });
        const inserted = await this.query(
          em,
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
           VALUES (?, ?, ?, now()) ON CONFLICT DO NOTHING RETURNING message_id`,
          [inboxMessage.consumerName, inboxMessage.messageId, inboxMessage.payloadHash],
        );
        if (inserted.length === 0) {
          await this.incrementCounter(em, 'idempotent_replays');
          return { duplicateMessage: true as const };
        }
      }

      const created = await this.query(
        em,
        `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
          status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [
          candidateId, input.providerId, input.externalTransactionId, input.idempotencyKey, payloadHash,
          input.walletId, input.playerId, input.roundId, input.gameId, input.kind,
          input.money.amount, input.money.currency, input.referenceExternalTransactionId ?? null,
          createdAt,
        ],
      );
      let transaction: DbRow;
      let replay = false;
      if (created.length === 0) {
        const existing = await this.query(
          em,
          'SELECT * FROM wager_transactions WHERE idempotency_key = ? FOR UPDATE',
          [input.idempotencyKey],
        );
        if (!existing[0]) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
        transaction = existing[0];
        if (transaction.payload_hash !== payloadHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'The idempotency key was already used with a different business payload',
          });
        }
        replay = true;
        await this.incrementCounter(em, 'idempotent_replays');
      } else {
        transaction = created[0];
        await this.processTransaction(em, transaction, false, inbox?.messageId);
        const refreshed = await this.query(em, 'SELECT * FROM wager_transactions WHERE id = ?', [candidateId]);
        transaction = refreshed[0];
      }

      if (inbox) {
        const inboxMessage = InboxMessage.receive({
          messageId: inbox.messageId,
          consumerName: CONSUMER_NAME,
          payloadHash: inbox.payloadHash,
          receivedAt: new Date(),
        });
        inboxMessage.markProcessed(new Date());
        await this.query(
          em,
          `UPDATE inbox_messages SET processed_at = now()
           WHERE consumer_name = ? AND message_id = ?`,
          [inboxMessage.consumerName, inboxMessage.messageId],
        );
      }
      const result = await this.resultFor(em, transaction, replay);
      return { ...result, duplicateMessage: false as const };
    });

    try {
      let lockRetries = 0;
      while (true) {
        try {
          return await process();
        } catch (error) {
          if (!this.isLockConflict(error) || lockRetries >= 2) throw error;
          lockRetries += 1;
          await new Promise((resolve) => setTimeout(resolve, 25 * lockRetries));
        }
      }
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'EXTERNAL_TRANSACTION_ALREADY_EXISTS',
          message: 'The provider transaction identifier has already been used',
        });
      }
      if (this.isLockConflict(error)) {
        await this.recordCounter('lock_conflicts');
        throw new ServiceUnavailableException({
          code: 'DATABASE_LOCK_CONFLICT',
          message: 'A concurrent database lock conflict interrupted processing; retry the request',
        });
      }
      throw error;
    }
  }

  async getWallet(walletId: string) {
    const rows = await this.query(
      this.orm.em,
      'SELECT id, player_id, currency, balance::text, version, created_at, updated_at FROM wallets WHERE id = ?',
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    return {
      id: row.id,
      playerId: row.player_id,
      balance: { amount: String(row.balance), currency: String(row.currency).trim() },
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getTransaction(transactionId: string) {
    const rows = await this.query(
      this.orm.em,
      `SELECT t.*, w.currency AS wallet_currency
       FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.id = ?`,
      [transactionId],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.serializeTransaction(rows[0]);
  }

  async getProviderTransaction(providerId: string, externalTransactionId: string) {
    const rows = await this.query(
      this.orm.em,
      `SELECT t.*, w.currency AS wallet_currency
       FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id
       WHERE t.provider_id = ? AND t.external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    return this.serializeTransaction(rows[0]);
  }

  async getLedger(walletId: string, cursor?: string, limitValue?: string) {
    await this.getWallet(walletId);
    const limit = this.parseLimit(limitValue);
    const decoded = cursor ? this.decodeCursor(cursor) : undefined;
    const rows = await this.query(
      this.orm.em,
      `SELECT id, transaction_id, direction, amount::text, currency, balance_before::text,
              balance_after::text, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = ?
         AND (?::timestamptz IS NULL OR (created_at, id) < (?::timestamptz, ?::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [walletId, decoded?.createdAt ?? null, decoded?.createdAt ?? null, decoded?.id ?? null, limit + 1],
    );
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit);
    const last = entries.at(-1);
    return {
      items: entries.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: String(row.amount), currency: String(row.currency).trim() },
        balanceBefore: { amount: String(row.balance_before), currency: String(row.currency).trim() },
        balanceAfter: { amount: String(row.balance_after), currency: String(row.currency).trim() },
        createdAt: row.created_at,
      })),
      nextCursor: hasMore && last ? this.encodeCursor(last.created_at, last.id) : null,
    };
  }

  async reconcile(walletId: string) {
    return this.orm.em.transactional(async (em) => {
      const wallets = await this.query(
        em,
        'SELECT balance::text, currency FROM wallets WHERE id = ?',
        [walletId],
      );
      if (!wallets[0]) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
      const totals = await this.query(
        em,
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,
                COUNT(*)::int AS entries
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [walletId],
      );
      const currency = String(wallets[0].currency).trim();
      const storedBalance = Money.from({ amount: String(wallets[0].balance), currency });
      const calculatedBalance = Money.from({ amount: String(totals[0].total), currency });
      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = difference.isZero();
      if (!consistent) {
        await this.incrementCounter(em, 'reconciliation_mismatches');
        console.error(JSON.stringify({
          event: 'wallet_reconciliation_mismatch',
          walletId,
          storedAmount: storedBalance.toJSON().amount,
          calculatedAmount: calculatedBalance.toJSON().amount,
        }));
      }
      return {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: totals[0].entries,
      };
    });
  }

  async processPendingReferences(): Promise<void> {
    const candidates = await this.query(
      this.orm.em,
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_retry_at <= now()
       ORDER BY next_retry_at, created_at LIMIT 25`,
    );
    for (const candidate of candidates) {
      try {
        await this.orm.em.transactional(async (em) => {
          const locked = await this.query(
            em,
            'SELECT * FROM wager_transactions WHERE id = ? FOR UPDATE SKIP LOCKED',
            [candidate.id],
          );
          if (!locked[0] || locked[0].status !== 'PENDING_REFERENCE') return;
          await this.processTransaction(em, locked[0], true);
          await this.incrementCounter(em, 'worker_retries');
        });
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pending_reference_retry_failed',
          transactionId: candidate.id,
          error: error instanceof Error ? error.message : 'unknown',
        }));
      }
    }
  }

  async databaseReady(): Promise<boolean> {
    await this.query(this.orm.em, 'SELECT 1');
    return true;
  }

  async metrics(): Promise<string> {
    const [statuses, counters, outbox, latency] = await Promise.all([
      this.query(this.orm.em, 'SELECT status, COUNT(*)::bigint AS count FROM wager_transactions GROUP BY status'),
      this.query(this.orm.em, 'SELECT name, value FROM operational_counters'),
      this.query(
        this.orm.em,
        `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::text AS lag_seconds
         FROM outbox_messages WHERE published_at IS NULL`,
      ),
      this.query(
        this.orm.em,
        `SELECT COALESCE(percentile_cont(0.95) WITHIN GROUP
         (ORDER BY EXTRACT(EPOCH FROM (processed_at - created_at)) * 1000), 0)::text AS p95_ms
         FROM wager_transactions WHERE processed_at IS NOT NULL`,
      ),
    ]);
    const lines = [
      '# HELP wager_transactions_total Wager transactions by persisted status.',
      '# TYPE wager_transactions_total gauge',
      ...statuses.map((row) =>
        `wager_transactions_total{status="${this.databaseString(row.status).toLowerCase()}"} ${this.databaseString(row.count)}`,
      ),
      '# HELP wager_idempotent_replays_total Replayed idempotent submissions.',
      '# TYPE wager_idempotent_replays_total counter',
      `wager_idempotent_replays_total ${this.counterValue(counters, 'idempotent_replays')}`,
      '# HELP wager_retries_total Durable worker retry attempts.',
      '# TYPE wager_retries_total counter',
      `wager_retries_total ${this.counterValue(counters, 'worker_retries')}`,
      '# HELP wager_lock_conflicts_total PostgreSQL lock/deadlock conflicts.',
      '# TYPE wager_lock_conflicts_total counter',
      `wager_lock_conflicts_total ${this.counterValue(counters, 'lock_conflicts')}`,
      '# HELP wager_reconciliation_mismatches_total Reconciliation checks that found a mismatch.',
      '# TYPE wager_reconciliation_mismatches_total counter',
      `wager_reconciliation_mismatches_total ${this.counterValue(counters, 'reconciliation_mismatches')}`,
      '# HELP wager_outbox_lag_seconds Age of the oldest unpublished outbox event.',
      '# TYPE wager_outbox_lag_seconds gauge',
      `wager_outbox_lag_seconds ${outbox[0] ? this.databaseString(outbox[0].lag_seconds) : '0'}`,
      '# HELP wager_processing_latency_p95_ms Persisted p95 transaction latency.',
      '# TYPE wager_processing_latency_p95_ms gauge',
      `wager_processing_latency_p95_ms ${latency[0] ? this.databaseString(latency[0].p95_ms) : '0'}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  async recordCounter(name: string): Promise<void> {
    await this.incrementCounter(this.orm.em, name);
  }

  private async incrementCounter(em: typeof this.orm.em, name: string): Promise<void> {
    await this.query(
      em,
      `INSERT INTO operational_counters (name, value) VALUES (?, 1)
       ON CONFLICT (name) DO UPDATE SET value = operational_counters.value + 1, updated_at = now()`,
      [name],
    );
  }

  private counterValue(counters: DbRow[], name: string): string {
    const counter = counters.find((row) => row.name === name);
    return counter ? this.databaseString(counter.value) : '0';
  }

  private async processTransaction(
    em: typeof this.orm.em,
    row: DbRow,
    isRetry = false,
    messageId?: string,
  ): Promise<void> {
    const transaction = this.toDomainTransaction(row);
    if (transaction.isTerminal()) return;
    const wallets = await this.query(
      em,
      'SELECT id, player_id, currency, balance::text, version, created_at, updated_at FROM wallets WHERE id = ? FOR UPDATE',
      [transaction.walletId],
    );
    const walletRow = wallets[0];
    if (!walletRow) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    const wallet = Wallet.rehydrate({
      id: String(walletRow.id),
      playerId: String(walletRow.player_id),
      currency: String(walletRow.currency).trim(),
      balance: Money.from({ amount: String(walletRow.balance), currency: String(walletRow.currency).trim() }),
      version: Number(walletRow.version),
      createdAt: new Date(String(walletRow.created_at)),
      updatedAt: new Date(String(walletRow.updated_at)),
    });

    if (wallet.playerId !== transaction.playerId) {
      await this.reject(em, transaction, wallet.balance, FailureCode.WalletPlayerMismatch, undefined, messageId);
      return;
    }
    if (wallet.currency !== transaction.money.currency) {
      await this.reject(em, transaction, wallet.balance, FailureCode.CurrencyMismatch, undefined, messageId);
      return;
    }

    const referenceExternalId = transaction.referenceExternalTransactionId;
    if (
      referenceExternalId &&
      ![
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
      ].includes(transaction.kind)
    ) {
      await this.reject(em, transaction, wallet.balance, FailureCode.InvalidReferenceKind, undefined, messageId);
      return;
    }
    let referenceRow: DbRow | undefined;
    if (referenceExternalId) {
      const references = await this.query(
        em,
        `SELECT * FROM wager_transactions
         WHERE provider_id = ? AND external_transaction_id = ? FOR UPDATE`,
        [transaction.providerId, referenceExternalId],
      );
      referenceRow = references[0];
      if (!referenceRow) {
        if (!isRetry) {
          await this.markPendingReference(em, transaction, wallet.balance, 0, messageId);
        } else {
          const attempts = Number(row.reference_attempts) + 1;
          if (attempts >= MAX_REFERENCE_ATTEMPTS) {
            await this.reject(em, transaction, wallet.balance, FailureCode.ReferenceNotFound, attempts, messageId);
          } else {
            await this.markPendingReference(em, transaction, wallet.balance, attempts, messageId);
          }
        }
        return;
      }
    }

    if (
      transaction.kind === WagerTransactionKind.Refund ||
      transaction.kind === WagerTransactionKind.Rollback ||
      (transaction.kind === WagerTransactionKind.Win && referenceExternalId)
    ) {
      const reference = referenceRow ? this.toDomainTransaction(referenceRow) : undefined;
      const mismatch =
        !reference ||
        reference.providerId !== transaction.providerId ||
        reference.playerId !== transaction.playerId ||
        reference.walletId !== transaction.walletId ||
        reference.money.currency !== transaction.money.currency ||
        reference.roundId !== transaction.roundId;
      if (mismatch) {
        await this.reject(em, transaction, wallet.balance, FailureCode.ReferenceMismatch, undefined, messageId);
        return;
      }
      if (reference.status !== WagerTransactionStatus.Processed) {
        await this.reject(em, transaction, wallet.balance, FailureCode.ReferenceNotProcessed, undefined, messageId);
        return;
      }
      const allowed =
        transaction.kind === WagerTransactionKind.Refund
          ? reference.kind === WagerTransactionKind.Bet
          : transaction.kind === WagerTransactionKind.Rollback
            ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind)
            : reference.kind === WagerTransactionKind.Bet;
      if (!allowed) {
        await this.reject(em, transaction, wallet.balance, FailureCode.InvalidReferenceKind, undefined, messageId);
        return;
      }
      if (
        [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(transaction.kind) &&
        (transaction.money.isLessThan(reference.money) || reference.money.isLessThan(transaction.money))
      ) {
        await this.reject(em, transaction, wallet.balance, FailureCode.AmountMismatch, undefined, messageId);
        return;
      }
      const reversed = await this.query(
        em,
        `SELECT id FROM wager_transactions
         WHERE reference_transaction_id = ? AND kind = ? AND status = 'PROCESSED'`,
        [reference.id, transaction.kind],
      );
      if (reversed.length) {
        await this.reject(em, transaction, wallet.balance, FailureCode.ReferenceAlreadyReversed, undefined, messageId);
        return;
      }
    }

    let entry;
    try {
      if (transaction.kind === WagerTransactionKind.Loss) {
        transaction.markProcessed(referenceRow ? String(referenceRow.id) : undefined, new Date());
      } else {
        let direction: LedgerDirection;
        if (transaction.kind === WagerTransactionKind.Rollback) {
          const reference = this.toDomainTransaction(referenceRow!);
          direction =
            reference.ledgerDirectionFor() === LedgerDirection.Debit
              ? LedgerDirection.Credit
              : LedgerDirection.Debit;
        } else {
          direction = transaction.ledgerDirectionFor();
        }
        const movement = {
          entryId: randomUUID(),
          transactionId: transaction.id,
          money: transaction.money,
          at: new Date(),
        };
        entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        await this.query(
          em,
          `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ?`,
          [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id],
        );
        await this.insertLedger(em, entry);
        transaction.markProcessed(referenceRow ? String(referenceRow.id) : undefined, new Date());
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'InsufficientFundsError') {
        await this.reject(
          em,
          transaction,
          wallet.balance,
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalInsufficientFunds,
          undefined,
          messageId,
        );
        return;
      }
      throw error;
    }

    await this.query(
      em,
      `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = ?, reference_transaction_id = ?,
       balance_snapshot = ?, failure_code = NULL, next_retry_at = NULL WHERE id = ?`,
      [transaction.processedAt, transaction.referenceTransactionId ?? null, wallet.balance.toJSON().amount, transaction.id],
    );
    const eventContext = {
      eventId: randomUUID(),
      correlationId: transaction.id,
      causationId: transaction.id,
      occurredAt: transaction.processedAt ?? new Date(),
    };
    await this.enqueue(em, WagerTransactionProcessed.from(transaction, eventContext));
    if (entry) {
      await this.enqueue(em, WalletBalanceChanged.from(wallet, entry, {
        ...eventContext,
        eventId: randomUUID(),
      }));
    }
    console.info(JSON.stringify({
      event: 'wager_processed',
      correlationId: transaction.id,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      status: transaction.status,
      messageId,
    }));
  }

  private async reject(
    em: typeof this.orm.em,
    transaction: WagerTransaction,
    balance: Money,
    code: FailureCode,
    attempts?: number,
    messageId?: string,
  ): Promise<void> {
    transaction.reject(code);
    await this.query(
      em,
      `UPDATE wager_transactions SET status = 'REJECTED', failure_code = ?, processed_at = now(),
       balance_snapshot = ?, reference_attempts = COALESCE(?, reference_attempts), next_retry_at = NULL
       WHERE id = ?`,
      [code, balance.toJSON().amount, attempts ?? null, transaction.id],
    );
    await this.enqueue(
      em,
      WagerTransactionRejected.from(transaction, {
        eventId: randomUUID(),
        correlationId: transaction.id,
        causationId: transaction.id,
        occurredAt: new Date(),
      }),
    );
    console.info(JSON.stringify({
      event: 'wager_rejected',
      correlationId: transaction.id,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      failureCode: code,
      messageId,
    }));
  }

  private async markPendingReference(
    em: typeof this.orm.em,
    transaction: WagerTransaction,
    balance: Money,
    attempts: number,
    messageId?: string,
  ): Promise<void> {
    transaction.markPendingReference();
    const delaySeconds = Math.min(2 ** attempts, 300);
    await this.query(
      em,
      `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', reference_attempts = ?,
       next_retry_at = now() + (? * interval '1 second'), balance_snapshot = ? WHERE id = ?`,
      [attempts, delaySeconds, balance.toJSON().amount, transaction.id],
    );
    if (attempts === 0) {
      await this.enqueue(
        em,
        WagerTransactionPendingReference.from(transaction, {
          eventId: randomUUID(),
          correlationId: transaction.id,
          causationId: transaction.id,
          occurredAt: new Date(),
        }),
      );
    }
    console.info(JSON.stringify({
      event: 'wager_pending_reference',
      correlationId: transaction.id,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      messageId,
      attempts,
    }));
  }

  private async insertLedger(em: typeof this.orm.em, entry: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
  }): Promise<void> {
    await this.query(
      em,
      `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id, entry.walletId, entry.transactionId, entry.direction,
        entry.money.toJSON().amount, entry.money.currency, entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount, entry.createdAt,
      ],
    );
  }

  private async enqueue(em: typeof this.orm.em, event: {
    eventId: string;
    aggregateId: string;
    eventType: string;
    occurredAt: Date;
    toJSON: () => object;
  }): Promise<void> {
    const message = OutboxMessage.enqueue(event as IntegrationEvent<unknown>);
    await this.query(
      em,
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       VALUES (?, ?, ?, ?::jsonb, ?)`,
      [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload), message.occurredAt],
    );
  }

  private async resultFor(em: typeof this.orm.em, transaction: DbRow, replay: boolean): Promise<WagerResult> {
    const wallets = await this.query(em, 'SELECT currency FROM wallets WHERE id = ?', [transaction.wallet_id]);
    if (!wallets[0]) throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
    let balance = transaction.balance_snapshot;
    if (balance === null || balance === undefined) {
      const wallets = await this.query(em, 'SELECT balance::text FROM wallets WHERE id = ?', [transaction.wallet_id]);
      balance = wallets[0]?.balance ?? '0.00';
    }
    return {
      transactionId: String(transaction.id),
      status: transaction.status as WagerTransactionStatus,
      balance: {
        amount: String(balance),
        currency: String(wallets[0].currency).trim(),
      },
      idempotentReplay: replay,
      ...(transaction.failure_code ? { failureCode: this.databaseString(transaction.failure_code) } : {}),
    };
  }

  private serializeTransaction(row: DbRow) {
    return {
      transactionId: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      money: { amount: String(row.amount), currency: String(row.currency).trim() },
      referenceExternalTransactionId: row.reference_external_transaction_id,
      referenceTransactionId: row.reference_transaction_id,
      status: row.status,
      failureCode: row.failure_code,
      balance: row.balance_snapshot === null ? null : {
        amount: this.databaseString(row.balance_snapshot),
        currency: String(row.wallet_currency).trim(),
      },
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }

  private toDomainTransaction(row: DbRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: String(row.id),
      providerId: String(row.provider_id),
      externalTransactionId: String(row.external_transaction_id),
      idempotencyKey: String(row.idempotency_key),
      payloadHash: String(row.payload_hash),
      walletId: String(row.wallet_id),
      playerId: String(row.player_id),
      roundId: String(row.round_id),
      gameId: String(row.game_id),
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: String(row.amount), currency: String(row.currency).trim() }),
      referenceExternalTransactionId: row.reference_external_transaction_id
        ? this.databaseString(row.reference_external_transaction_id)
        : undefined,
      createdAt: new Date(String(row.created_at)),
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.reference_transaction_id ? this.databaseString(row.reference_transaction_id) : undefined,
      failureCode: row.failure_code as FailureCode | undefined,
      processedAt: row.processed_at ? new Date(this.databaseString(row.processed_at)) : undefined,
    });
  }

  private validateInput(value: unknown): WagerInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Transaction body must be an object');
    }
    const input = value as Record<string, unknown>;
    const required = ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId'];
    for (const key of required) {
      if (typeof input[key] !== 'string' || !input[key].trim()) throw new TypeError(`${key} is required`);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.walletId as string)) {
      throw new TypeError('walletId must be a UUID');
    }
    if (!Object.values(WagerTransactionKind).includes(input.kind as WagerTransactionKind) ||
        input.kind === WagerTransactionKind.Opening) {
      throw new TypeError('kind must be BET, WIN, LOSS, REFUND, or ROLLBACK');
    }
    if (input.referenceExternalTransactionId !== undefined &&
        (typeof input.referenceExternalTransactionId !== 'string' || !input.referenceExternalTransactionId.trim())) {
      throw new TypeError('referenceExternalTransactionId must be a non-empty string');
    }
    const money = Money.from(input.money as { amount: string; currency: string }).toJSON();
    const validated = {
      providerId: input.providerId as string,
      externalTransactionId: input.externalTransactionId as string,
      idempotencyKey: input.idempotencyKey as string,
      playerId: input.playerId as string,
      walletId: input.walletId as string,
      roundId: input.roundId as string,
      gameId: input.gameId as string,
      kind: input.kind as WagerTransactionKind,
      money,
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId as string }
        : {}),
    };
    if (
      (validated.kind === WagerTransactionKind.Refund || validated.kind === WagerTransactionKind.Rollback) &&
      !validated.referenceExternalTransactionId
    ) {
      throw new TypeError(`${validated.kind} requires referenceExternalTransactionId`);
    }
    if (validated.kind !== WagerTransactionKind.Loss && !Money.from(validated.money).isPositive()) {
      throw new TypeError(`${validated.kind} amount must be greater than zero`);
    }
    return validated;
  }

  private hashInput(input: WagerInput): string {
    const canonical = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private parseLimit(value?: string): number {
    const parsed = value === undefined ? 50 : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new TypeError('limit must be an integer between 1 and 100');
    }
    return parsed;
  }

  private encodeCursor(createdAt: unknown, id: unknown): string {
    return Buffer.from(JSON.stringify({ createdAt: new Date(String(createdAt)).toISOString(), id: String(id) })).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
      if (Number.isNaN(Date.parse(parsed.createdAt))) throw new Error();
      return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
      throw new TypeError('cursor is invalid');
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error &&
      (error as { code?: string }).code === '23505';
  }

  private isLockConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code && ['40001', '40P01', '55P03'].includes(code)) return true;
    return 'cause' in error ? this.isLockConflict(error.cause) : false;
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

  private databaseString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    throw new TypeError('Unexpected database value type');
  }
}
