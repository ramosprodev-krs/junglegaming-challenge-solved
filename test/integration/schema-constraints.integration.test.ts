import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM, type QueryResult } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Migration20261030000000 } from '../../src/migrations/Migration20261030000000';
import { persistenceEntities } from '../../src/infrastructure/persistence/entity-schemas';

const databaseUrl = process.env.DATABASE_URL;

describe('PostgreSQL schema constraints', () => {
  if (!databaseUrl) {
    test.skip('set DATABASE_URL to verify schema constraints against PostgreSQL', () => {});
    return;
  }

  let orm: MikroORM;

  const query = async (sql: string, params: unknown[] = []) => {
    const result = await orm.em.getConnection().execute<Record<string, unknown>>(
      sql,
      params,
      'all',
      orm.em.getTransactionContext(),
    );
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as QueryResult<Record<string, unknown>>).rows ?? []) as Record<string, unknown>[];
  };

  const insertWallet = async (id: string, playerId: string, balance = '100.00') =>
    query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', ?, 1, now(), now())`,
      [id, playerId, balance],
    );

  const insertWager = async (options: {
    id?: string;
    walletId: string;
    providerId?: string;
    externalId?: string;
    idempotencyKey?: string;
    kind?: string;
    status?: string;
    referenceId?: string | null;
  }) => {
    const id = options.id ?? randomUUID();
    const providerId = options.providerId ?? `provider-${randomUUID()}`;
    const externalId = options.externalId ?? `external-${randomUUID()}`;
    const idempotencyKey = options.idempotencyKey ?? `key-${randomUUID()}`;
    await query(
      `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
        player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'player', 'round', 'game', ?, 10.00, 'BRL',
               CASE WHEN ? IN ('REFUND', 'ROLLBACK') THEN 'reference' ELSE NULL END,
               ?, ?, now())`,
      [
        id,
        providerId,
        externalId,
        idempotencyKey,
        'a'.repeat(64),
        options.walletId,
        options.kind ?? 'BET',
        options.kind ?? 'BET',
        options.referenceId ?? null,
        options.status ?? 'PENDING',
      ],
    );
    return { id, providerId, externalId, idempotencyKey };
  };

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: databaseUrl,
      entities: persistenceEntities,
      migrations: {
        migrationsList: [Migration20261030000000],
        tableName: 'mikro_orm_migrations',
      },
    });
    const tables = await query("SELECT to_regclass('public.wallets') AS wallets");
    if (!tables[0]?.wallets) await orm.migrator.up();
  }, 30_000);

  afterAll(async () => {
    await orm?.close(true);
  });

  test('wallet constraints enforce uniqueness and a non-negative balance', async () => {
    const walletId = randomUUID();
    const playerId = `constraint-player-${randomUUID()}`;
    await insertWallet(walletId, playerId);

    await expect(insertWallet(randomUUID(), playerId)).rejects.toBeDefined();
    await expect(insertWallet(randomUUID(), `negative-${randomUUID()}`, '-0.01')).rejects.toBeDefined();
  });

  test('wager constraints enforce provider/external and idempotency uniqueness plus status checks', async () => {
    const walletId = randomUUID();
    await insertWallet(walletId, `wager-player-${randomUUID()}`);
    const wager = await insertWager({ walletId });

    await expect(insertWager({
      walletId,
      providerId: wager.providerId,
      externalId: wager.externalId,
    })).rejects.toBeDefined();
    await expect(insertWager({
      walletId,
      idempotencyKey: wager.idempotencyKey,
    })).rejects.toBeDefined();
    await expect(insertWager({ walletId, status: 'UNKNOWN' })).rejects.toBeDefined();
  });

  test('processed reversals are unique per referenced transaction and kind', async () => {
    const walletId = randomUUID();
    await insertWallet(walletId, `reversal-player-${randomUUID()}`);
    const bet = await insertWager({ walletId, status: 'PROCESSED' });

    await insertWager({
      walletId,
      kind: 'REFUND',
      status: 'PROCESSED',
      referenceId: bet.id,
    });
    await expect(insertWager({
      walletId,
      kind: 'REFUND',
      status: 'PROCESSED',
      referenceId: bet.id,
    })).rejects.toBeDefined();
  });

  test('ledger constraints enforce arithmetic, one entry per wallet/transaction and immutability', async () => {
    const walletId = randomUUID();
    await insertWallet(walletId, `ledger-player-${randomUUID()}`);
    const wager = await insertWager({ walletId, status: 'PROCESSED' });
    const entryId = randomUUID();

    await expect(query(
      `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'CREDIT', 10.00, 'BRL', 0.00, 9.00, now())`,
      [randomUUID(), walletId, wager.id],
    )).rejects.toBeDefined();

    await query(
      `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'CREDIT', 10.00, 'BRL', 0.00, 10.00, now())`,
      [entryId, walletId, wager.id],
    );
    await expect(query(
      `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'CREDIT', 10.00, 'BRL', 0.00, 10.00, now())`,
      [randomUUID(), walletId, wager.id],
    )).rejects.toBeDefined();
    await expect(query('UPDATE wallet_ledger_entries SET amount = 11.00 WHERE id = ?', [entryId]))
      .rejects.toBeDefined();
    await expect(query('DELETE FROM wallet_ledger_entries WHERE id = ?', [entryId]))
      .rejects.toBeDefined();
  });

  test('inbox composite key prevents duplicate delivery records', async () => {
    const messageId = `message-${randomUUID()}`;
    await query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES ('constraint-test', ?, ?, now())`,
      [messageId, 'b'.repeat(64)],
    );
    await expect(query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES ('constraint-test', ?, ?, now())`,
      [messageId, 'b'.repeat(64)],
    )).rejects.toBeDefined();
  });
});
