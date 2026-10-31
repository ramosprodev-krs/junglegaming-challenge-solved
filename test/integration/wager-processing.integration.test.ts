import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ConflictException } from '@nestjs/common';
import { WagerProcessorService } from '../../src/application/wager-processor.service';
import { Migration20261030000000 } from '../../src/migrations/Migration20261030000000';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { persistenceEntities } from '../../src/infrastructure/persistence/entity-schemas';

const databaseUrl = process.env.DATABASE_URL;

describe('PostgreSQL multi-instance wager invariants', () => {
  if (!databaseUrl) {
    test.skip('set DATABASE_URL to run real PostgreSQL concurrency tests', () => {});
    return;
  }

  let firstOrm: MikroORM;
  let secondOrm: MikroORM;
  let thirdOrm: MikroORM;
  let first: WagerProcessorService;
  let second: WagerProcessorService;
  let third: WagerProcessorService;

  beforeAll(async () => {
    const options = {
      driver: PostgreSqlDriver,
      clientUrl: databaseUrl,
      entities: persistenceEntities,
      migrations: {
        migrationsList: [Migration20261030000000],
        tableName: 'mikro_orm_migrations',
      },
    };
    firstOrm = await MikroORM.init(options);
    await firstOrm.migrator.up();
    secondOrm = await MikroORM.init(options);
    thirdOrm = await MikroORM.init(options);
    first = new WagerProcessorService(firstOrm);
    second = new WagerProcessorService(secondOrm);
    third = new WagerProcessorService(thirdOrm);
  });

  afterAll(async () => {
    await Promise.all([firstOrm?.close(true), secondOrm?.close(true), thirdOrm?.close(true)]);
  });

  test('50 duplicate deliveries across two app instances debit exactly once', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await first.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const input = {
      providerId: 'integration-provider',
      externalTransactionId: crypto.randomUUID(),
      idempotencyKey: `integration:${crypto.randomUUID()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-duplicate',
      gameId: 'test-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        [first, second, third][index % 3].submitWager(input, {
          messageId: `redelivery-${input.externalTransactionId}`,
          payloadHash: 'b'.repeat(64),
        }),
      ),
    );
    const transactionResults = results.filter((result) => !result.duplicateMessage);
    await expect(first.submitWager({
      ...input,
      money: { amount: '26.00', currency: 'BRL' },
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(first.submitWager({
      ...input,
      money: { amount: '26.00', currency: 'BRL' },
    })).rejects.toBeInstanceOf(ConflictException);
    const ledger = await first.getLedger(wallet.id, undefined, '100');
    const updatedWallet = await second.getWallet(wallet.id);

    expect(new Set(transactionResults.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => result.duplicateMessage).length).toBe(49);
    expect(transactionResults[0]?.idempotentReplay).toBe(false);
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT').length).toBe(1);
    expect(updatedWallet.balance.amount).toBe('75.00');
    expect((await first.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('two concurrent 80.00 bets against 100.00 permit exactly one debit', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await first.createWallet(playerId, { amount: '100.00', currency: 'BRL' });
    const submissions = [0, 1].map((index) => {
      const externalTransactionId = `race-${crypto.randomUUID()}-${index}`;
      return {
        providerId: 'integration-provider',
        externalTransactionId,
        idempotencyKey: `integration:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-race',
        gameId: 'test-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      };
    });
    const results = await Promise.all([
      first.submitWager(submissions[0]),
      second.submitWager(submissions[1]),
    ]);
    const transactionResults = results.filter((result) => !result.duplicateMessage);
    const ledger = await first.getLedger(wallet.id, undefined, '100');
    const updatedWallet = await second.getWallet(wallet.id);

    expect(transactionResults.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(transactionResults.filter((result) => result.status === 'REJECTED')).toHaveLength(1);
    expect(ledger.items.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect(updatedWallet.balance.amount).toBe('20.00');
    expect((await first.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('a reversal delivered before its bet is processed after the reference arrives', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await first.createWallet(playerId, { amount: '50.00', currency: 'BRL' });
    const refundId = `refund-${crypto.randomUUID()}`;
    const referencedBetId = `bet-arrives-later-${crypto.randomUUID()}`;
    const refund = await first.submitWager({
      providerId: 'integration-provider',
      externalTransactionId: refundId,
      idempotencyKey: `integration:${refundId}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-reference',
      gameId: 'test-game',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: referencedBetId,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect('status' in refund ? refund.status : undefined).toBe(WagerTransactionStatus.PendingReference);

    await first.submitWager({
      providerId: 'integration-provider',
      externalTransactionId: referencedBetId,
      idempotencyKey: `integration:${referencedBetId}`,
      playerId,
      walletId: wallet.id,
      roundId: 'round-reference',
      gameId: 'test-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await second.processPendingReferences();

    const result = await third.getProviderTransaction('integration-provider', refundId);
    const updatedWallet = await first.getWallet(wallet.id);
    expect(result.status).toBe('PROCESSED');
    expect(updatedWallet.balance.amount).toBe('50.00');
    expect((await first.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('different wallets are processed concurrently without a shared wallet lock', async () => {
    const playerIds = [crypto.randomUUID(), crypto.randomUUID()];
    const wallets = await Promise.all(playerIds.map((playerId) =>
      first.createWallet(playerId, { amount: '40.00', currency: 'BRL' }),
    ));
    const submissions = wallets.map((wallet, index) => {
      const externalTransactionId = `parallel-wallet-${crypto.randomUUID()}-${index}`;
      return {
        providerId: 'integration-provider',
        externalTransactionId,
        idempotencyKey: `integration:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-parallel-wallets',
        gameId: 'test-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '15.00', currency: 'BRL' },
      };
    });
    const results = await Promise.all([
      first.submitWager(submissions[0]),
      second.submitWager(submissions[1]),
    ]);

    expect(results.every((result) => !result.duplicateMessage && result.status === 'PROCESSED')).toBe(true);
    const balances = await Promise.all(wallets.map((wallet) => third.getWallet(wallet.id)));
    expect(balances.map((wallet) => wallet.balance.amount)).toEqual(['25.00', '25.00']);
  });
});
