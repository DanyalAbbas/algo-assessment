# Algo Assessment — Fintech Wallet with Transaction Intelligence

A small fintech application built for a mid-level software engineer assessment. It supports account balances, idempotent fund transfers that stay correct under concurrency, transaction history, AI-powered transaction categorization that learns from user corrections, and spending insights.

Built with **NestJS**, **TypeScript**, **PostgreSQL** (via Prisma), and **Groq** (`openai/gpt-oss-120b`) for the LLM integration.

See [DECISIONS.md](./DECISIONS.md) for the engineering reasoning behind every significant choice.

---

## Features

- **Accounts & balances** — balances stored as exact integer cents (`BIGINT`), never floats.
- **Transfers** — atomic money movement backed by a double-entry ledger (a `DEBIT` and a `CREDIT` per transfer). Row-level locking (`SELECT ... FOR UPDATE`) in deterministic order prevents deadlocks and overdrafts.
- **Idempotency** — every transfer requires an idempotency key (body or `Idempotency-Key` header). Replays return the original result; concurrent duplicates are deduplicated by a database unique constraint so money never moves twice.
- **Transaction history** — full ledger with running balances, filterable by account.
- **Transaction Intelligence Agent** — categorization runs in the background and never blocks or fails a transfer; `POST /transactions/:id/categorize` forces it synchronously. A real LLM categorizes every described transaction into one of: Food & Dining, Groceries, Transport, Bills & Utilities, Shopping, Entertainment, Health, Sadqa & Zakaat, Salary, Transfers, or Other. Users can review and correct categories, and corrections are stored and injected into future LLM prompts as few-shot examples, so the system improves at categorizing similar transactions over time.
- **Spending insights** — monthly summary, top spending categories, month-over-month trend, and unusual-activity detection (transactions 2σ above the user's own average).

---

## Tech stack

- NestJS 11 + TypeScript
- PostgreSQL 16 + Prisma 6
- Groq (`openai/gpt-oss-120b`)
- JWT auth (register/login) with bcrypt
- Jest + Supertest for end-to-end tests

---

## Running locally

### Prerequisites

- Node.js 20+
- Docker (for the local Postgres) — or a local PostgreSQL 14+ instance

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env`:
- `DATABASE_URL` — defaults to the Docker Compose database below; change it if you use your own Postgres.
- `JWT_SECRET` — any long random string.
- `GROQ_API_KEY` — your Groq key from <https://console.groq.com/keys>. (Without it, the app still runs; transactions are simply left as `Uncategorized`.)

### 3. Start PostgreSQL

```bash
npm run db:up        # docker compose up -d
```

Or point `DATABASE_URL` at an existing Postgres instance.

### 4. Create the schema and seed demo users

```bash
npx prisma migrate deploy   # apply migrations
npm run seed                # create demo users + funded accounts
npm run prisma:generate     # (usually runs automatically)
```

### 5. Start the server

```bash
npm run start:dev           # development, watch mode
# or
npm run build && npm run start:prod
```

The API is available at `http://localhost:3000`. Health check: `GET /health`.

### Demo accounts (seeded)

| Email | Password | Starting balance |
|---|---|---|
| `alice@example.com` | `password123` | $1,000.00 (100000 cents) |
| `bob@example.com` | `password123` | $500.00 (50000 cents) |

---

## Running the tests

The end-to-end tests run against a **separate test database** so they never touch your dev data.

```bash
# one-time setup of the test DB
PGPASSWORD=app createdb -h localhost -U app algo_assessment_test
DATABASE_URL=postgresql://app:app@localhost:5432/algo_assessment_test npx prisma migrate deploy

# run the suite
npm run test:e2e
```

The suite proves the core guarantees:
- replay of an identical request does not move money twice
- 10 concurrent identical requests produce exactly one transfer
- 20 concurrent transfers against a 1,000-cent balance succeed exactly 10 times, ending at exactly zero (no negative balance, no double spend)
- same idempotency key with a different payload is rejected (`409`)
- insufficient funds, self-transfer, missing key, and non-owned source accounts are all rejected

---

## API reference

All endpoints except `POST /auth/register`, `POST /auth/login`, and `GET /health` require a JWT:

```
Authorization: Bearer <accessToken>
```

### Auth

Access tokens are **short-lived (15 minutes)**. The long-lived credential is an opaque, rotating, server-side-revocable **refresh token** (7 days by default). The JWT secret is validated at startup — the app **refuses to boot** if `JWT_SECRET` is missing, shorter than 32 characters, or a known placeholder. Generate one with `openssl rand -base64 48`. See [DECISIONS.md §7](./DECISIONS.md) for the security reasoning.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password, name }` | 201. Creates a user + a default account. Returns `{ accessToken, refreshToken, refreshTokenExpiresAt, user }`. |
| POST | `/auth/login` | `{ email, password }` | 201. Same response shape as register. Rate limited (10/min). |
| POST | `/auth/refresh` | `{ refreshToken }` | 201. Rotates the refresh token; returns a new `{ accessToken, refreshToken, ... }` pair. Rotation is compare-and-swap, so concurrent reuse of one token yields exactly one winner; a revoked-token replay revokes **all** of the user's sessions (theft detection). |
| POST | `/auth/logout` | `{ refreshToken }` | Revokes one refresh token. |
| POST | `/auth/logout-all` | *(auth required)* | Revokes every refresh token for the user. |
| GET | `/auth/me` | — | Returns the authenticated user. |

### Accounts

| Method | Path | Notes |
|---|---|---|
| POST | `/accounts` | Body `{ name? }`. Creates an account. |
| GET | `/accounts` | Lists the user's accounts with balances (in cents). |
| GET | `/accounts/:id/balance` | Returns one account's balance. |

### Transfers

`POST /transfers`

```json
{
  "sourceAccountId": "uuid",
  "destAccountId": "uuid",
  "amount": 2500,
  "description": "Lunch with Bob",
  "idempotencyKey": "client-generated-unique-key"
}
```

- `amount` is a positive integer in **cents**.
- `idempotencyKey` (min 8 chars) may be sent in the body **or** as an `Idempotency-Key` header. It is **required**.
- If **both** are supplied, their trimmed values must match — otherwise the request is rejected with `400` and no funds move. The server never silently picks one over the other, because a client that thinks it is deduplicating by a key the server ignored has no idempotency guarantee at all. A blank/whitespace-only value on either side counts as "not supplied".
- Response includes the `Transfer`, its two ledger `transactions`, the post-transfer account balances, and a `replayed` flag (`true` when the request was a duplicate).
- **Privacy:** `source` is your own account (full detail). `dest` returns only `{ id, currency }` — the recipient's balance, account name, and internal user id are never exposed, on either the fresh or replay path.
- Reusing a key with the **same** payload returns the original transfer with `replayed: true` and does not move money again.
- Reusing a key with a **different** payload returns `409 Conflict`. The canonical payload is `sourceAccountId`, `destAccountId`, `amount`, and `description`. Descriptions are trimmed, and an omitted / empty / whitespace-only description all canonicalise to `null`, so they count as the *same* payload and replay rather than conflict.
- **Replay determinism:** a replay returns the same body as the original request, including the account balances **as of that transfer** (reconstructed from the ledger's `balanceAfter`), not the live balances. If later activity changed an account, the retry still reports the original result.

### Transactions

| Method | Path | Notes |
|---|---|---|
| GET | `/transactions?accountId=&limit=&offset=` | Paginated ledger across the user's accounts, newest first. Each entry has `type`, `amount`, `balanceAfter`, `description`, `category`. |
| POST | `/transactions/:id/categorize` | *(auth required)*. Categorizes this transaction **now** and waits for the result. Background categorization is the default; use this when you need a category immediately. Returns `{ transactionId, category }`. |
| POST | `/transactions/:id/category` | Body `{ correctedCategory }`. Must be one of the canonical categories — `Food & Dining`, `Groceries`, `Transport`, `Bills & Utilities`, `Shopping`, `Entertainment`, `Health`, `Sadqa & Zakaat`, `Salary`, `Transfers`, `Other` — otherwise `400`. Corrects a transaction's category and records the correction for future learning. |
| GET | `/transactions/corrections` | Lists the user's past corrections. |

### Insights

`GET /insights?month=YYYY-MM` (month optional, defaults to current UTC month)

Returns:
- `monthly` — total spend, total income, net, transaction count
- `byCategory` — top spending categories with share-of-spend percentages
- `trend` — spend this month vs last month (absolute + percentage change)
- `unusual` — debits more than 2 standard deviations above the user's own average, with context

### Health

`GET /health` → `{ status: "ok", timestamp }`

---

## Example walkthrough

```bash
# 1. Login as Alice
ALICE=$(curl -s -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"password123"}' | jq -r .accessToken)

# 2. Login as Bob and grab both account IDs
BOB=$(curl -s -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"bob@example.com","password":"password123"}' | jq -r .accessToken)
ALICE_ACCT=$(curl -s localhost:3000/accounts -H "Authorization: Bearer $ALICE" | jq -r '.[0].id')
BOB_ACCT=$(curl -s localhost:3000/accounts -H "Authorization: Bearer $BOB" | jq -r '.[0].id')

# 3. Send $25 (2500 cents)
curl -s -X POST localhost:3000/transfers \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d "{\"sourceAccountId\":\"$ALICE_ACCT\",\"destAccountId\":\"$BOB_ACCT\",\"amount\":2500,\"description\":\"Lunch with Bob\",\"idempotencyKey\":\"demo-key-001\"}" | jq

# 4. Retry the exact same request — safe, returns replayed:true, no double spend
# 5. View history (see the auto-generated category)
curl -s localhost:3000/transactions -H "Authorization: Bearer $ALICE" | jq '.transactions'
# 6. Correct a category if you disagree — future similar transactions learn from it
curl -s -X POST localhost:3000/transactions/<id>/category \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d '{"correctedCategory":"Food & Dining"}' | jq
# 7. Insights
curl -s localhost:3000/insights -H "Authorization: Bearer $ALICE" | jq
```

---

## Project structure

```
src/
  auth/            JWT auth (register/login), guards, decorators
  accounts/        Account creation, listing, balances
  transfers/       Transfer engine — idempotency, locking, atomic money movement
  transactions/    Transaction history (ledger queries)
  categorization/  Groq LLM integration + category corrections (learning loop)
  insights/        Monthly summary, categories, trend, anomalies
  prisma/          Prisma service (global)
prisma/
  schema.prisma    Data model (User, Account, Transfer, Transaction, CategoryCorrection)
  seed.ts          Demo users (alice/bob) with funded accounts
test/
  transfers.e2e-spec.ts   Idempotency + concurrency + edge-case tests
```
