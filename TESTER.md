# TESTER.md — Information for Security & Functional Testers

This file contains **only** the information you need to test this application. For design reasoning, see `DECISIONS.md`. For full setup, see `README.md`.

## What this is

A fintech wallet API (NestJS + TypeScript + PostgreSQL + Prisma) with:
- User accounts with balances (integer cents)
- Idempotent, concurrent-safe fund transfers (double-entry ledger)
- AI transaction categorization (Groq LLM) with user corrections that improve future categorization
- Spending insights

## Live instance

A deployed instance is running at **https://algo-assessment-api.onrender.com** (health: `GET /health`). It uses the same seeded demo accounts. Two caveats when testing it:
- The first request after ~15 min idle can take ~30-50s while the free instance wakes.
- Free-tier CPU means sustained bursts beyond ~20 concurrent transfers may queue or fail. Correctness is unaffected; test with 10-20 concurrent.

Running locally is preferable for load testing.

## Running it locally

```bash
npm install
cp .env.example .env         # then fill GROQ_API_KEY (optional; without it, categories stay "Uncategorized")
npm run db:up                # docker postgres on :5432
npx prisma migrate deploy
npm run seed                 # creates demo users below
npm run start:dev            # API on http://localhost:3000
```

Health check: `GET http://localhost:3000/health` → `{"status":"ok",...}`

## Demo credentials (seeded)

| Email | Password | Starting balance |
|---|---|---|
| alice@example.com | password123 | 100000 cents ($1000.00) |
| bob@example.com | password123 | 50000 cents ($500.00) |

## Auth

All money/history endpoints require `Authorization: Bearer <accessToken>`.

- Access token: **15-minute JWT** (short-lived by design)
- Refresh token: **opaque 7-day token**, returned at login/register, rotated on every refresh
- Login/register return: `{ accessToken, refreshToken, refreshTokenExpiresAt, user }`
- The server **refuses to start** if `JWT_SECRET` is missing, <32 chars, or a known placeholder. If the app boots, the secret is non-default.
- **Rate limiting is active.** Login/register allow 60 requests/min per IP; all other routes allow 2000/min. Exceeding either returns **429**. The generous non-auth limit is deliberate — this API is meant to be exercised by concurrent test suites from a single IP, and a tight global cap would reject legitimate load and mask real results.
- Login is timing-hardened: an unknown email takes the same time as a known one.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password, name }` | 201. Creates user + default account |
| POST | `/auth/login` | `{ email, password }` | 201 |
| POST | `/auth/refresh` | `{ refreshToken }` | 201. Rotates via compare-and-swap: firing N concurrent refreshes with the same token yields **exactly one** 201 and N-1 × 401 (the rest are treated as reuse). Replaying a revoked token revokes **all** sessions for that user (theft detection). |
| POST | `/auth/logout` | `{ refreshToken }` | Revokes one token |
| POST | `/auth/logout-all` | *(auth required)* | Revokes all tokens for user |
| GET | `/auth/me` | — | Current user |

Amounts everywhere are **integer cents**. Currency is USD (single-currency by design).

## Endpoints

### Accounts
| Method | Path | Notes |
|---|---|---|
| POST | `/accounts` | Body `{ name? }` |
| GET | `/accounts` | Lists accounts + balances |
| GET | `/accounts/:id/balance` | One account's balance |

### Transfers (the critical endpoint)
`POST /transfers`

```json
{
  "sourceAccountId": "uuid",
  "destAccountId": "uuid",
  "amount": 2500,
  "description": "Lunch with Bob",
  "idempotencyKey": "min-8-chars-client-generated"
}
```

- `amount`: positive integer cents, required
- `idempotencyKey`: **required** — body field OR `Idempotency-Key` header (min 8 chars)
- If **both** the body field and the header are supplied and their trimmed values differ → **400**, and nothing is written (no balance change, no transfer, no ledger row). The server does not pick a winner. Sending both with matching values is fine.
- Response (201): transfer object with `transactions[]` (the DEBIT + CREDIT ledger entries), post-transfer balances, and `replayed` flag
- **Privacy contract:** `source` (yours) has full detail. `dest` is `{ id, currency }` ONLY — the recipient's balance/name/userId are never returned, on the fresh path or the replay path. If you can recover a counterparty's balance from a transfer response, that is a finding.

**Idempotency contract:**
- Same key + same payload → returns original transfer, `replayed: true`, **no second money movement**
- Same key + different payload → **409 Conflict**
- Concurrent identical requests (same key) → exactly one transfer created; all callers get the same transfer id

**Rejection cases (all verified by tests):**
- Insufficient funds → 400, **nothing persisted** (key is not consumed; can retry after funding)
- Self-transfer (source == dest) → 400
- Missing/short idempotency key → 400
- Source account not owned by caller → 400
- Amount <= 0 or non-integer → 400

### Transaction history
| Method | Path | Notes |
|---|---|---|
| GET | `/transactions?accountId=&limit=&offset=` | Paginated, newest first. Each entry: `type` (DEBIT/CREDIT), `amount`, `balanceAfter`, `description`, `category`, `createdAt` |
| POST | `/transactions/:id/category` | Body `{ correctedCategory }`. **Must be one of the canonical categories** — `Food & Dining`, `Groceries`, `Transport`, `Bills & Utilities`, `Shopping`, `Entertainment`, `Health`, `Sadqa & Zakaat`, `Salary`, `Transfers`, `Other`. Anything else → **400** (this bound also prevents prompt injection via the correction feedback loop). Corrects + records the correction. |
| POST | `/transactions/:id/categorize` | Categorizes now and waits. Returns `{ transactionId, category }`. 404 if the transaction belongs to another user. |
| GET | `/transactions/corrections` | Lists user's past corrections |

### Insights
`GET /insights?month=YYYY-MM` (month optional). A malformed month (e.g. `abc`, `2024-13`) returns **400**, not 500.

Returns: `monthly` (spend/income/net/count), `byCategory` (top categories + % of spend), `trend` (month-over-month), `unusual` (debits > 2σ above user's own mean).

## Known behaviors & intentional limitations (not bugs)

- **Rate limiting exists but is coarse** — per-IP counters in memory; no per-account lockout or exponential backoff
- **No frontend UI** — API-only by design
- **Single currency (USD)** — no FX
- **Categorization is asynchronous** — it never blocks or fails a transfer. A described transaction shows `Uncategorized` in the immediate `POST /transfers` response and gets its real category a moment later (poll `GET /transactions`, or call `POST /transactions/:id/categorize` to wait for it). A transfer with **no `description`** is categorised `Transfers` immediately without any LLM call.
- **Without `GROQ_API_KEY`** (or when the provider is down / rate-limited) everything stays `Uncategorized`; transfers are unaffected.
- **Category is the only mutable ledger field** (required by the correction feature). Amounts/balances are write-once.
- **Idempotency keys never expire** (stricter than Stripe's ~24h TTL)
- **Failed transfers (insufficient funds) are not persisted** — by design; the key isn't consumed
- **Demo users are public knowledge** (`alice`/`bob`) — register your own users for isolated testing

## Invariants you should try to break

1. **No negative balance, ever** — under any concurrency
2. **No double-spend** — concurrent distinct transfers from one account never move more than the balance
3. **No duplicate transfers** — same idempotency key never produces two transfers, even under concurrency
4. **Ledger consistency** — every transfer has exactly 2 entries (1 DEBIT + 1 CREDIT); `balanceAfter` reconstructs current balance
5. **Isolation** — user A cannot read/spend/correct user B's accounts or transactions
6. **Token security** — refresh-token reuse after rotation/revocation is detected and kills all sessions; concurrent refresh of one token yields exactly one winner
7. **Disclosure** — no endpoint returns another user's balance, account name, or internal userId; forged JWTs signed with a guessable/default key are rejected
8. **Input validation** — category corrections must be allow-listed; malformed `month` returns 400; unknown body fields are rejected (400)

## Running the test suite

```bash
# one-time test DB setup
PGPASSWORD=app createdb -h localhost -U app algo_assessment_test
DATABASE_URL=postgresql://app:app@localhost:5432/algo_assessment_test npx prisma migrate deploy

npm run test:e2e
```

Tests (64 across 7 e2e suites, plus 15 unit tests via `npm test`):
- **transfers** — replay, concurrent identical requests (10-way), concurrent distinct overdraw race (20-way), payload-mismatch 409, insufficient funds, self-transfer, missing key, non-owned source, header-based idempotency.
- **transfers.regression** — drained-source concurrent retry must replay (not 400), description as part of the payload, unsafe-integer rejection with no ledger writes, first-run vs replay shape parity, counterparty redaction on both paths.
- **idempotency-key** — conflicting body/header keys rejected without side effects; matching, body-only and header-only accepted; mismatch rejected even when it would otherwise replay.
- **async-categorization** — description-less transfers short-circuit to `Transfers`, transfers never block on the LLM, on-demand categorize endpoint, cross-user access refused.
- **auth/session** — JWT secret fail-fast (missing / `dev-secret` / placeholder / high-entropy), sequential rotation chain, replay-after-rotation rejected, concurrent rotation compare-and-swap (exactly 1 winner of 10), invalid token rejected, logout revocation, counterparty-balance/userId non-disclosure.
- **insights** — month-parameter format and range validation (valid months, `abc`, month `00`/`13`, January/December boundaries).
- **rate-limit** — repeated failed logins return 429.
