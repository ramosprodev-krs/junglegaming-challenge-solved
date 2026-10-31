import { EntitySchema } from '@mikro-orm/core';

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  processedAt: Date | null;
  balanceSnapshot: string | null;
  referenceAttempts: number;
  nextRetryAt: Date | null;
  createdAt: Date;
}

export interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export interface OperationalCounterRow {
  name: string;
  value: string;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)', length: 3 },
    balance: { type: 'decimal', columnType: 'numeric(20,2)' },
    version: { type: 'integer' },
    createdAt: { type: Date, fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: Date, fieldName: 'updated_at', columnType: 'timestamptz' },
  },
  uniques: [{ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] }],
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', unique: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)', length: 64 },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)', length: 3 },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      type: 'uuid',
      fieldName: 'reference_transaction_id',
      nullable: true,
    },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    processedAt: { type: Date, fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
    balanceSnapshot: {
      type: 'decimal',
      fieldName: 'balance_snapshot',
      columnType: 'numeric(20,2)',
      nullable: true,
    },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts', default: 0 },
    nextRetryAt: { type: Date, fieldName: 'next_retry_at', columnType: 'timestamptz', nullable: true },
    createdAt: { type: Date, fieldName: 'created_at', columnType: 'timestamptz' },
  },
  uniques: [
    {
      name: 'wager_provider_external_unique',
      properties: ['providerId', 'externalTransactionId'],
    },
    {
      name: 'wager_reference_kind_unique',
      properties: ['referenceTransactionId', 'kind'],
      where: `status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`,
    },
  ],
  indexes: [
    {
      name: 'wager_transactions_pending_reference_idx',
      properties: ['status', 'nextRetryAt', 'createdAt'],
      where: `status = 'PENDING_REFERENCE'`,
    },
  ],
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  name: 'WalletLedgerEntryRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)', length: 3 },
    balanceBefore: { type: 'decimal', fieldName: 'balance_before', columnType: 'numeric(20,2)' },
    balanceAfter: { type: 'decimal', fieldName: 'balance_after', columnType: 'numeric(20,2)' },
    createdAt: { type: Date, fieldName: 'created_at', columnType: 'timestamptz' },
  },
  uniques: [
    {
      name: 'wallet_ledger_wallet_transaction_unique',
      properties: ['walletId', 'transactionId'],
    },
  ],
  indexes: [
    {
      name: 'wallet_ledger_cursor_idx',
      properties: ['walletId', 'createdAt', 'id'],
    },
  ],
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  name: 'InboxMessageRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'string', primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)', length: 64 },
    receivedAt: { type: Date, fieldName: 'received_at', columnType: 'timestamptz' },
    processedAt: { type: Date, fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  name: 'OutboxMessageRow',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: Date, fieldName: 'occurred_at', columnType: 'timestamptz' },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { type: Date, fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: Date, fieldName: 'published_at', columnType: 'timestamptz', nullable: true },
  },
  indexes: [
    {
      name: 'outbox_pending_idx',
      properties: ['occurredAt', 'id'],
      where: 'published_at IS NULL',
    },
  ],
});

export const OperationalCounterSchema = new EntitySchema<OperationalCounterRow>({
  name: 'OperationalCounterRow',
  tableName: 'operational_counters',
  properties: {
    name: { type: 'string', primary: true },
    value: { type: 'bigint' },
    updatedAt: {
      type: Date,
      fieldName: 'updated_at',
      columnType: 'timestamptz',
      defaultRaw: 'now()',
    },
  },
});

export const persistenceEntities = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
  OperationalCounterSchema,
];
