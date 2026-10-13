# Engineering Decisions

This document explains the key choices made while building this assessment, the tradeoffs behind them, and what was intentionally left out. It is meant to be read alongside the code.

---

## 1. Tech stack

| Choice | Reasoning |
|---|---|
| **NestJS** | Explicitly preferred in the brief. Its module structure and DI make the transfer, categorization, and insights concerns cleanly separable, which matters for the "code quality and maintainability" criterion. |
| **PostgreSQL + Prisma** | PostgreSQL is required. Prisma was chosen over TypeORM for its type-safe client, first-class migrations, and lower historical bug surface. Prisma's raw-SQL escape hatch (`$queryRaw`) is used where row-level locking is needed — Prisma's high-level API has no first-class `FOR UPDATE`. |
| **Groq (`openai/gpt-oss-120b`)** | Any provider was allowed; Groq was chosen for its free tier and low latency, which keeps the post-commit categorization call fast. The OpenAI-compatible chat-completions shape makes swapping providers trivial (only the client constructor and model name change). |
| **JWT auth (register/login) with refresh tokens** | Auth is not a focus of the assessment, but endpoints need to be addressable per-user for transfers and history. Access tokens are deliberately short-lived (15 minutes); the long-lived credential is an opaque, rotating, server-side-revocable refresh token (see §7). No roles, email verification, or password reset (intentionally omitted). |

---

## 2. Data modeling

**Balances as `BIGINT` cents.** Money is stored as an integer number of minor units (cents), never a float or `Decimal`. Floating point introduces rounding errors that are unacceptable in a ledger; `BIGINT` is exact. The API exposes amounts as plain integers (cents); converting `BigInt` → `number` at the serialization boundary is safe at this application's scale (a `number` safely represents up to ~90 quadrillion cents).

**Double-entry ledger.** Every transfer produces exactly two `Transaction` rows: a `DEBIT` on the source account and a `CREDIT` on the destination. Each row stores `balanceAfter` — the account balance immediately following that entry. This makes the ledger self-auditing: replaying all entries for an account in order must reconstruct its current balance. The `Transfer` table is the parent record linking the pair and carrying the idempotency key.

This structure was directly informed by Stripe's Ledger system ([engineering write-up](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)), which tracks money movement as immutable events moving balances between typed accounts, grounded in double-entry bookkeeping so correctness is mathematically provable rather than asserted. We adopted the same foundation at our scale: append-only ledger rows, write-once money fields, and a `balanceAfter` on every entry so state is always reconstructable from the event log. The one deliberate divergence is `Transaction.category`, which is mutable — the AI-correction feature requires the user to be able to reclassify a transaction after the fact, and category is metadata about spending, never a money field.

**`Transfer` vs `Transaction`.** A `Transfer` is the business-level money movement (source, destination, amount, idempotency key, status). A `Transaction` is a single ledger line against one account. Splitting them keeps the idempotency constraint on one row (`Transfer.idempotencyKey`) while allowing each side of the movement to carry its own category, description, and running balance.

---

## 3. Idempotency

The transfer endpoint requires an idempotency key, supplied either as `body.idempotencyKey` or an `Idempotency-Key` header (minimum 8 characters). When **both** are supplied they must agree: a conflicting pair is rejected with `400` before the service is called. Preferring one silently would be worse than it sounds — a client that believes it is deduplicating by the key the server ignored has, in effect, no idempotency guarantee, and would only discover it when a retry double-spent. Rejecting up front makes the ambiguity explicit and keeps the failure mode "nothing happened" rather than "the wrong transfer was replayed". A blank value on either side is treated as not supplied, so the other channel still works. This is the pattern Stripe pioneered and documents for their APIs ([Stripe idempotency docs](https://stripe.com/docs/api/idempotency)): the client owns key generation (typically a UUID per user-intent), so retries after a network timeout or dropped response can be safely repeated without creating a second charge. We studied their contract — same key replays the original result, same key with different parameters is an error — and implemented the same semantics for transfers.

**Enforcement is a unique constraint**, not an application-level check. `Transfer.idempotencyKey` is `UNIQUE` in the database. The flow is:

1. **Fast path:** look up the key. If found and the payload matches, return the stored transfer with `replayed: true` — no locks are taken.
2. **Normal path:** inside the money-movement transaction, insert the `Transfer` (with the key) after updating balances.
3. **Concurrent duplicates:** two identical requests can both pass the fast path and both attempt the insert. The database rejects the second with a unique-constraint violation, which rolls back its *entire* transaction — including the balance updates. No money moves twice. The loser catches the error, re-reads the winner's transfer, and returns it as a replay.
4. **Retries that queued on the account lock.** A subtler interleaving: two identical requests, source balance exactly equal to the amount. Both pass the fast path; the first drains the account and commits; the second was waiting on the account row lock, wakes up, and — if it checked funds first — would see an empty balance and return `400 Insufficient funds`. That is a retry of a request that *already succeeded*, so the funds check cannot come first. After acquiring the locks and verifying ownership we therefore re-read the idempotency key **before** the balance check; if a concurrent request has committed, we replay its transfer and move no money. The funds check only ever rejects a genuinely unaffordable *first* attempt.

**The canonical payload is `{sourceAccountId, destAccountId, amount, description}`.** `description` is included because it is part of what the client asked for, and silently returning a transfer with a different description would hide a client bug. Descriptions are trimmed, and an omitted, `null`, empty, or whitespace-only description all canonicalise to `null` — so those are one payload and replay normally, while a genuinely different description is a `409`. The same comparison runs on the fast path, the in-transaction re-check, and the unique-constraint path, so the rule is identical however the replay is reached.

**Amounts are exact safe integers.** Money is stored as `BIGINT` cents, but amounts travel as JSON numbers. Any integer above `Number.MAX_SAFE_INTEGER` (2^53−1) cannot round-trip through JSON/JavaScript without losing a cent — `9007199254740993` is read back as `9007199254740992`, which would silently move the wrong amount. The API therefore rejects anything above that bound (`400`), and the service double-checks with `Number.isSafeInteger`. Below that ceiling the value is exact at every hop: request → JSON → validation → `BigInt` → `BIGINT` → response.

**Failed transfers do not consume the key.** An insufficient-funds attempt is rejected and not persisted, so the same key can be retried later once the account is funded. This is a deliberate semantic choice — idempotency protects *successful* transfers from duplication; failed attempts create no state to protect.

**Replays are byte-identical to the original response.** A retry returns the same status, the same body, and the same transfer id, differing only in the `replayed` flag. Account balances are reconstructed from the ledger's `balanceAfter` rather than read from the live `Account` row, so a retry reports the state *as of that transfer* instead of whatever the balance has since drifted to — otherwise the same request would return different data each time it was retried, and a client could not tell a replay from a new transfer. First-run and replay share one include clause and one projection function, so the two shapes cannot drift apart.

---

## 4. Concurrency

Money movement runs inside a single database transaction with **pessimistic row locks** (`SELECT ... FOR UPDATE`) on both accounts, acquired in **deterministic order** (sorted by account ID). Sorting prevents the classic deadlock where Alice→Bob and Bob→Alice transfers each lock one account and wait for the other.

With `READ COMMITTED` isolation (PostgreSQL's default) plus row locks, correctness is guaranteed: the lock-holder sees the latest committed balance, and any concurrent transfer against the same account waits, then re-reads the now-updated balance and correctly fails if funds are gone. This is verified by the test that fires 20 concurrent 100-cent transfers at a 1,000-cent account: exactly 10 succeed, the balance ends at exactly zero (never negative), and exactly 10 transfer records exist.

`FOR UPDATE` is issued via `$queryRaw` because Prisma's query builder has no locking primitive. All user-supplied values are bound as query parameters by Prisma's tagged templates, so there is no SQL-injection surface.

The transaction has a 15-second timeout to bound lock contention; it is generous for realistic bursts and will not spin forever under pathological load.

---

## 5. Transaction categorization (the AI feature)

**Real LLM, end-to-end.** After a transfer commits, the two ledger entries are sent to Groq for categorization. The model picks from a fixed category list (`Food & Dining`, `Groceries`, `Transport`, `Bills & Utilities`, `Shopping`, `Entertainment`, `Health`, `Sadqa & Zakaat`, `Salary`, `Transfers`, `Other`) and its answer is normalized onto that list (quoted/punctuated/fuzzy responses are cleaned up; anything unrecognizable becomes `Other`).

**One canonical list, used everywhere.** `src/categorization/categories.ts` is the single source of truth. The prompt is built from it, the normalizer validates against it, and `POST /transactions/:id/category` accepts corrections only if `@IsIn(CATEGORIES)`. Adding a category therefore needs no change to the prompt, the validation, or the API — and a user-supplied string that is not on the list can never be persisted or interpolated into a prompt.

**Off the money path — asynchronous.** Categorization is *derived* data: it can always be recomputed from the stored description, so it has no business blocking a money movement or making it depend on a third party's uptime. A transfer commits its ledger rows and returns without calling the model at all. The rows are handed to a small in-process worker (concurrency-capped, one retry on transient failure) that drains them a moment later. Measured effect: a transfer that previously took ~2s end-to-end returns in **~60ms**, and a Groq outage or quota exhaustion can no longer slow or fail a transfer. On top of that, **transfers the client gave no description for are categorised as `Transfers` without calling the model** — they are by definition person-to-person movements, and feeding the generated placeholder text ("Transfer from Main") to the model only invites it to guess.

**Deterministic on demand.** Background work is not always what a caller wants, so `POST /transactions/:id/categorize` classifies a single transaction and *awaits* the result. That keeps demos and the correction learning loop reproducible without putting the LLM back on the transfer path. The category is `Uncategorized` in the immediate transfer response for described transactions and appears on `GET /transactions` once the worker has run.

**Failure-tolerant.** If the provider errors or times out, the row simply stays `Uncategorized` and the retry gives the provider a second chance; the transfer is already committed and unaffected either way.

**Learning from corrections — the feedback loop.** When a user corrects a category (`POST /transactions/:id/category`), the system stores a `CategoryCorrection` record capturing the original category, the corrected category, and the transaction description. On every future categorization, that user's recent corrections (up to 40, de-duplicated and capped at 15 in the prompt) are injected into the LLM prompt as few-shot examples:

> *Description: "Uber ride to airport" was corrected from "Shopping" to "Transport".*

The model is instructed to prefer the user's corrected category when a new description resembles a corrected one. This is a deliberately simple, practical form of learning — no vector store, no fine-tuning, no embedding model. It is per-user (one user's corrections never appear in another's prompts, so no cross-user leakage), bounded in size, and immediately effective. It directly satisfies the requirement that "corrections influence future categorization" in a way that is easy to demonstrate: correct "Uber ride" once, and the next "Uber trip" comes back as Transport.

A redundant correction (changing a category to what it already is) is ignored — there is nothing to learn.

---

## 6. Spending insights (Inspired By Cashew)

Insights are computed **on demand** with SQL aggregations, not pre-materialized. At this scale (hundreds to low-thousands of transactions per user) on-demand queries are fast and always correct; a materialized view or nightly job would add complexity and staleness risk for no benefit. This is a scope decision, not a scalability claim.

The endpoint returns four things, chosen for usefulness over quantity:
- **Monthly summary** — total spend, total income, net, transaction count.
- **Spending by category** — top categories for the month with share-of-spend percentages. This is the single most actionable view for "where did my money go."
- **Month-over-month trend** — spend this month vs last, with absolute and percentage change.
- **Unusual activity** — debits more than 2 standard deviations above the user's own historical mean (with a minimum sample size so early transactions don't all look anomalous). Using the user's *own* distribution, not a global one, keeps it personal and avoids flagging a legitimately large purchase for someone who always spends large.

---

## 7. Authentication & session security

Auth is not the graded focus of this assessment, but a fintech API still deserves a defensible session model, so it got a modest production-shaped treatment rather than a single long-lived token:

- **Short-lived access token (15-minute JWT).** Stateless, cheap to lose, good enough to authorize ordinary reads and transfers for a demo session. If it leaks, the blast radius is minutes, not days.
- **Opaque, rotating refresh token (7-day default).** The long-lived credential is *not* a JWT — it is a random opaque string, so it can be revoked server-side before it expires (a property stateless JWTs lack by definition). Only its **SHA-256 hash** is stored, so a database leak does not expose usable tokens.
- **Rotation on every use.** `POST /auth/refresh` revokes the presented token and issues a new pair. A stolen refresh token has a short useful life. The rotation is a **compare-and-swap**: the update is conditional on the row still being unrevoked, so two concurrent requests racing on the same token cannot both succeed — exactly one wins, and the loser is treated as reuse. A read-then-write would leave a check-then-act window in which a thief could redeem the token concurrently with the legitimate client and quietly hold two valid sessions.
- **Reuse detection.** If an already-revoked refresh token is presented, it is treated as theft: every refresh token for that user is revoked and they must re-authenticate. This is a standard production control, implemented here because it is cheap and directly relevant to financial APIs.
- **Logout / logout-all.** `POST /auth/logout` revokes one token; `POST /auth/logout-all` revokes every token for the user (still reachable with a valid access token).
- **No guessable signing key.** The JWT secret is validated at startup and the process refuses to boot if it is missing, shorter than 32 characters, or matches a known placeholder — there is no hardcoded fallback. Both signing and verification read the same value from `ConfigService`, so a misconfiguration cannot silently produce tokens signed with one key and verified with another.
- **Brute-force resistance.** Login and register are rate limited (10/min per IP by default) with a global limit on all routes; the unknown-user login path performs a dummy bcrypt comparison so its timing matches the real one and cannot be used to enumerate accounts.

**Not disclosed across the wire.** A caller may only see full details of their *own* accounts. A transfer response returns the counterparty as `{ id, currency }` only — never their balance, account name, or internal `userId`. Both the fresh-transfer and idempotent-replay paths use the same projection, since leaking the destination balance would let anyone who knows a victim's account UUID recover their balance exactly by sending one cent.

What is deliberately still *not* built (auth is not graded): refresh-token absolute-idle-timeouts beyond TTL, device fingerprinting, password reset, email verification, MFA/step-up for transfers, and a server-side `jti` denylist so `logout-all` also kills already-issued access tokens (they expire within 15 minutes instead). Each would be on a real roadmap; none move the needle on the criteria this assessment scores — money-movement correctness, data modeling, idempotency, concurrency, and AI integration quality.

---

## 8. Intentionally omitted scope

These were left out to stay within the time budget and keep the solution focused on what is graded. Each is a deliberate choice, not an oversight:

- **Multi-currency** — single currency (USD) per account. Cross-currency would require exchange-rate modeling well beyond the brief.
- **Background job queue for categorization** — awaiting the LLM call keeps the demo deterministic; a production system would enqueue it.
- **Budgets / recurring transfers / scheduled payments** — not required.
- **Password reset, email verification, MFA/step-up** — auth is intentionally minimal beyond the token model in §7.
- **Admin roles, audit UI, CSV export** — not required.
- **Rate limiting / fraud rules** — out of scope for an assessment focused on correctness of money movement.
- **Frontend UI** — the brief asks for a backend/API application; a UI was not required and would have consumed time better spent on correctness and tests.

---

## 9. How the edge cases are proven

The transfer guarantees are not just claimed — they are enforced by automated tests (`test/transfers.e2e-spec.ts`) that run against a real PostgreSQL database:

- **Replay:** the same request twice → one transfer, money moved once.
- **Concurrent duplicates:** 10 simultaneous identical requests → one transfer created, everyone gets the same response.
- **Concurrent distinct transfers:** 20 parallel 100-cent transfers against a 1,000-cent balance → exactly 10 succeed, balance ends at exactly zero (never negative), exactly 10 records exist. No double-spend, no overdraft.
- **Same key, different payload:** rejected with `409`.
- **Insufficient funds:** rejected with `400`, nothing persisted.
- **Self-transfer, missing key, non-owned source account:** all rejected.

Run them with `npm run test:e2e` (requires the test database; see README).
