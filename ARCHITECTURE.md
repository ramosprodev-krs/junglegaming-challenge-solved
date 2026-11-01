# Architecture

## Overview

Wager Processor receives wallet operations over HTTP or SQS and applies them
to PostgreSQL. Both entry points call `WagerProcessorService`, so financial
rules are shared. The project uses a pragmatic DDD structure: domain rules are
modeled separately, while the application service coordinates MikroORM
transactions and parameterized SQL directly.

| Area | Responsibility |
|---|---|
| `src/domain` | Money, wallet, wager, ledger, inbox/outbox and event rules |
| `src/application` | Use cases, database transactions, queries and reconciliation |
| `src/http` | Controllers, guard and HTTP error mapping |
| `src/infrastructure` | PostgreSQL mappings, SQS client and workers |
| `src/migrations` | Versioned database schema |

## Key decisions

### Money

Amounts are decimal strings in API contracts, `Decimal` in the domain and
`numeric(20,2)` in PostgreSQL. This avoids binary floating-point errors.
Currency codes are checked for a three-uppercase-letter format; the code does
not validate them against a complete ISO currency list.

### Concurrency and database integrity

The service locks the target wallet row with `SELECT ... FOR UPDATE`. Requests
for one wallet are serialized, while different wallets can be processed
concurrently. PostgreSQL constraints provide a second line of defense for
non-negative balances, uniqueness and ledger integrity. Lock conflicts are
retried a limited number of times before returning an error.

### Idempotency

`Idempotency-Key` is stored in PostgreSQL with a SHA-256 hash of the business
payload. Repeating the same key and payload returns the existing result;
reusing the key with different business data is a conflict. The database also
enforces uniqueness of `(provider_id, external_transaction_id)`. SQS FIFO
deduplication is not the source of financial correctness.

### Wallet and ledger

The wallet balance is materialized for fast reads. Each balance change and its
immutable ledger entry are committed in the same PostgreSQL transaction.
`LOSS` records an operation without changing balance. Reconciliation compares
the stored balance with the net ledger total and reports differences; it does
not repair them automatically.

### Inbox, outbox and SQS

The SQS consumer records its inbox entry with the operation and acknowledges
the message after the database work completes. Financial events are stored in
the outbox in the same transaction as the wallet change, then published to
SQS. Delivery is at-least-once: a crash after SQS accepts an event but before
the database records publication can produce a duplicate. Downstream
consumers should deduplicate by `eventId`.

The current outbox publisher holds a database transaction while sending to
SQS. This keeps the claim logic straightforward with `FOR UPDATE SKIP LOCKED`,
but a slow broker can hold database connections and locks longer. A future
claim/lease design could shorten that transaction, but would need its own
recovery and duplicate-publication tests.

### References and retries

Operations that arrive before their referenced transaction remain
`PENDING_REFERENCE` and are retried with exponential backoff. After ten
attempts, the operation is rejected with `REFERENCE_NOT_FOUND`.

### ORM and SQL

MikroORM provides NestJS integration, connections and transaction management.
Critical paths use parameterized SQL to make locking, `ON CONFLICT` and
`SKIP LOCKED` behavior explicit. The trade-off is that query mapping and
database details remain the application's responsibility.

## Authentication

Authentication is intentionally not implemented, as allowed by the challenge.
`ProviderAuthGuard` is a no-op extension point: it currently permits requests
and does not verify provider identity. Before production exposure, integrate
an external OIDC/JWT identity provider and authorize the authenticated
identity against `providerId`. Health endpoints remain public as required.

## Validation and known gaps

Integration tests use PostgreSQL and LocalStack. They cover database
constraints, duplicate deliveries, concurrent bets, separate wallet
connections, SQS redelivery and a reference arriving late. The concurrency
test creates separate ORM instances in one OS process; it does not prove
multi-process behavior.

The current suite does not explicitly test crash/restart between commit and
SQS acknowledgement, effective DLQ redrive, independent concurrent outbox
publishers or three separate application processes. These should not be
claimed as verified guarantees.

Run instructions and Postman examples are in `README.md`. Local and AWS
infrastructure configuration is in `INFRASTRUCTURE.md`.
