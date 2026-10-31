import { Migration } from '@mikro-orm/migrations';

export class Migration20261030000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id text NOT NULL,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
      );

      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        processed_at timestamptz,
        balance_snapshot numeric(20, 2) CHECK (balance_snapshot IS NULL OR balance_snapshot >= 0),
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_retry_at timestamptz,
        created_at timestamptz NOT NULL,
        CONSTRAINT wager_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_reference_required CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR kind NOT IN ('REFUND', 'ROLLBACK')
        )
      );
      CREATE INDEX wager_transactions_wallet_created_idx ON wager_transactions(wallet_id, created_at DESC, id DESC);
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions(next_retry_at) WHERE status = 'PENDING_REFERENCE';
      CREATE UNIQUE INDEX wager_reference_kind_unique
        ON wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');

      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_balance_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
      ALTER TABLE wallet_ledger_entries
        ADD CONSTRAINT wallet_ledger_wallet_transaction_unique UNIQUE (wallet_id, transaction_id);
      CREATE INDEX wallet_ledger_cursor_idx ON wallet_ledger_entries(wallet_id, created_at DESC, id DESC);

      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER wallet_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz
      );
      CREATE INDEX outbox_pending_idx ON outbox_messages(occurred_at, id)
        WHERE published_at IS NULL;

      CREATE TABLE operational_counters (
        name text PRIMARY KEY,
        value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS outbox_messages;
      DROP TABLE IF EXISTS operational_counters;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TRIGGER IF EXISTS wallet_ledger_immutable ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS reject_ledger_mutation();
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
    `);
  }
}
