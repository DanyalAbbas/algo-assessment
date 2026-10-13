import {
  ConflictException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CategorizationService } from '../categorization/categorization.service';
import { CreateTransferDto } from './dto/create-transfer.dto';

/**
 * Canonical form of the optional `description` field, used both when storing a
 * transfer and when comparing an idempotent replay against the stored one.
 * Absent, null, empty and whitespace-only descriptions are all the SAME
 * payload (canonicalised to null) so a client retry that omits the field never
 * collides with the original request.
 */
export function canonicalDescription(value?: string | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Canonical payload for idempotency: the fields that define *what* the client
 * asked us to do. `description` is included so that reusing a key while
 * changing the description is rejected as a client bug rather than silently
 * returning the original transfer.
 */
function canonicalPayload(dto: CreateTransferDto) {
  return {
    sourceAccountId: dto.sourceAccountId,
    destAccountId: dto.destAccountId,
    amount: dto.amount,
    description: canonicalDescription(dto.description),
  };
}

/**
 * True for failures that happen BEFORE any money moved: the transaction never
 * started (pool exhaustion, wait timeout, transient connection loss). These
 * are safe to retry because the whole unit of work is one DB transaction that
 * either commits or rolls back.
 */
function isRetryable(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return (
    /Unable to start a transaction/i.test(msg) ||
    /Timed out fetching a new connection/i.test(msg) ||
    /maxWait|Timeout expired/i.test(msg) ||
    /P1008|P2024|P2034/.test(msg)
  );
}

export interface TransferResult {
  transfer: any;
  replayed: boolean;
}

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  // One shared include for every read of a transfer, so the first-run path and
  // the idempotent-replay path are guaranteed to observe the same fields and
  // therefore produce byte-identical response shapes.
  //
  // The secondary sort key makes the ledger ordering deterministic: both rows
  // are inserted inside the same transaction and can share a millisecond
  // (TIMESTAMP(3)), in which case Postgres is free to return either order.
  private readonly transferInclude: Prisma.TransferInclude = {
    transactions: {
      orderBy: [{ createdAt: 'asc' }, { type: 'desc' }],
    },
    source: {
      select: { id: true, userId: true, name: true, currency: true },
    },
    dest: {
      select: { id: true, userId: true, name: true, currency: true },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly categorization: CategorizationService,
  ) {}

  async execute(
    userId: string,
    dto: CreateTransferDto,
    idempotencyKey: string,
    attempt = 0,
  ): Promise<TransferResult> {
    if (dto.sourceAccountId === dto.destAccountId) {
      throw new BadRequestException('Cannot transfer to the same account');
    }
    // isSafeInteger, not isInteger: amounts travel as JSON numbers, and any
    // integer above Number.MAX_SAFE_INTEGER cannot round-trip through the
    // runtime exactly. Rejecting here prevents a cent being silently lost.
    if (!Number.isSafeInteger(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException(
        'Amount must be a positive safe integer (cents)',
      );
    }

    // Fast path: an identical request already completed — return its result
    // without touching the lock path at all. The lookup is scoped to the
    // caller so another user's key is indistinguishable from a missing one.
    const existing = await this.prisma.transfer.findFirst({
      where: { idempotencyKey, source: { userId } },
      include: this.transferInclude,
    });
    if (existing) {
      return this.replay(existing, dto, userId);
    }

    let outcome;
    try {
      outcome = await this.prisma.$transaction(
        async (tx) => {
          // Lock both account rows in deterministic (id) order to avoid
          // deadlocks when two transfers move money in opposite directions.
          const locked = await tx.$queryRaw<
            Array<{
              id: string;
              userId: string;
              balance: bigint;
              name: string;
              currency: string;
            }>
          >`
            SELECT id, "userId", balance, name, currency
            FROM "Account"
            WHERE id IN (${dto.sourceAccountId}, ${dto.destAccountId})
            ORDER BY id ASC
            FOR UPDATE
          `;

          const source = locked.find((a) => a.id === dto.sourceAccountId);
          const dest = locked.find((a) => a.id === dto.destAccountId);
          if (!source || !dest) {
            throw new NotFoundException(
              'Source or destination account not found',
            );
          }
          if (source.userId !== userId) {
            throw new BadRequestException('You do not own the source account');
          }

          // A concurrent identical request may have been waiting on this very
          // row lock and committed while we waited for it. Re-check the key
          // now that we hold the locks and BEFORE the funds check: otherwise
          // such a retry sees a drained balance and is rejected with
          // "Insufficient funds" instead of being replayed. No money moves on
          // this path — the concurrent request already moved it exactly once.
          const concurrent = await tx.transfer.findFirst({
            where: { idempotencyKey, source: { userId } },
            include: this.transferInclude,
          });
          if (concurrent) {
            return { kind: 'replay' as const, row: concurrent };
          }

          if (source.balance < BigInt(dto.amount)) {
            throw new BadRequestException('Insufficient funds');
          }

          const sourceAfter = source.balance - BigInt(dto.amount);
          const destAfter = dest.balance + BigInt(dto.amount);

          await tx.account.update({
            where: { id: source.id },
            data: { balance: sourceAfter },
          });
          await tx.account.update({
            where: { id: dest.id },
            data: { balance: destAfter },
          });

          const transfer = await tx.transfer.create({
            data: {
              idempotencyKey,
              sourceAccountId: source.id,
              destAccountId: dest.id,
              amount: BigInt(dto.amount),
              status: 'COMPLETED',
              description: canonicalDescription(dto.description),
            },
          });

          const sourceLabel = `${source.name}`;
          const destLabel = `${dest.name}`;
          const provided = canonicalDescription(dto.description);
          const debitDescription = provided || `Transfer to ${destLabel}`;
          const creditDescription = provided || `Transfer from ${sourceLabel}`;

          // A transfer the client gave no description for is, by definition, a
          // person-to-person movement — so it is categorised as "Transfers"
          // directly instead of being sent to the LLM. This is both cheaper and
          // more accurate: the generated text ("Transfer from Main") gives the
          // model nothing to work with and it guesses.
          const initialCategory = provided ? 'Uncategorized' : 'Transfers';

          const debit = await tx.transaction.create({
            data: {
              accountId: source.id,
              transferId: transfer.id,
              type: 'DEBIT',
              amount: BigInt(dto.amount),
              balanceAfter: sourceAfter,
              description: debitDescription,
              category: initialCategory,
            },
          });
          const credit = await tx.transaction.create({
            data: {
              accountId: dest.id,
              transferId: transfer.id,
              type: 'CREDIT',
              amount: BigInt(dto.amount),
              balanceAfter: destAfter,
              description: creditDescription,
              category: initialCategory,
            },
          });

          return {
            kind: 'created' as const,
            row: {
              ...transfer,
              source: { ...source, balance: sourceAfter },
              dest: { ...dest, balance: destAfter },
              transactions: [debit, credit],
            },
          };
        },
        // `maxWait` governs how long a request may wait to ACQUIRE a
        // connection before giving up. Prisma's default is only 2s, which a
        // burst of concurrent transfers reliably exceeds — the request then
        // fails with a 500 even though no money had moved. Queuing for longer
        // is the correct behaviour; the transaction itself is still bounded by
        // `timeout`.
        { timeout: 15_000, maxWait: 20_000 },
      );
    } catch (err) {
      // A transaction that could not even START (pool exhaustion / wait
      // timeout) has moved no money and written nothing, so re-running it is
      // atomic and safe. Retry briefly before surfacing a failure.
      if (isRetryable(err) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        return this.execute(userId, dto, idempotencyKey, attempt + 1);
      }
      // Concurrent duplicate that did NOT share an account lock (different
      // source/destination rows), so both transactions ran the re-check above
      // before either committed and both raced to insert. The loser hits the
      // unique constraint and its whole transaction — including the balance
      // updates — rolls back, so no money moves twice.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.transfer.findFirst({
          where: { idempotencyKey, source: { userId } },
          include: this.transferInclude,
        });
        if (winner) {
          return this.replay(winner, dto, userId);
        }
        // The key exists but belongs to another user.
        throw new ConflictException(
          'Idempotency key is already in use by another account',
        );
      }
      throw err;
    }

    if (outcome.kind === 'replay') {
      // Validate ownership + payload exactly as the fast path does.
      return this.replay(outcome.row, dto, userId);
    }

    // Categorization is deliberately OFF the money-movement path. The ledger
    // rows are already committed; we hand them to a background worker and
    // return. A slow, quota-exhausted or offline LLM therefore adds no latency
    // to the transfer and can never fail it.
    this.categorization.enqueue(
      outcome.row.transactions
        .filter((t: { category: string }) => t.category === 'Uncategorized')
        .map((t: { id: string }) => t.id),
    );

    return { transfer: this.present(outcome.row, userId), replayed: false };
  }

  /**
   * Return an already-processed transfer for a repeated request.
   *
   * Uses the SAME payload comparison and the SAME response projection as the
   * first run, so a retry is byte-identical to the original answer. Balances
   * are reconstructed from the ledger's `balanceAfter` rather than read from
   * the live Account row: a retry must report the state as of the transfer,
   * not whatever the balance has since drifted to, otherwise the same request
   * would return different data on each retry.
   */
  private replay(
    existing: any,
    dto: CreateTransferDto,
    userId: string,
  ): TransferResult {
    if (existing.source.userId !== userId) {
      // Do not leak another user's transfer via an idempotency-key probe.
      throw new NotFoundException('Transfer not found');
    }
    const stored = {
      sourceAccountId: existing.sourceAccountId,
      destAccountId: existing.destAccountId,
      amount: Number(existing.amount),
      description: canonicalDescription(existing.description),
    };
    const incoming = canonicalPayload(dto);
    const samePayload =
      stored.sourceAccountId === incoming.sourceAccountId &&
      stored.destAccountId === incoming.destAccountId &&
      stored.amount === incoming.amount &&
      stored.description === incoming.description;
    if (!samePayload) {
      throw new ConflictException(
        'Idempotency key was already used with a different payload',
      );
    }
    return { transfer: this.present(existing, userId), replayed: true };
  }

  /**
   * Project a transfer row into the public response shape. Applied identically
   * on first run and on replay.
   *
   * The caller always owns the source account (enforced in execute), so its
   * details are always returned in full. The destination is returned in full
   * only when the caller owns it too; for another user's account we expose the
   * id and currency and nothing else — leaking its balance or name would let
   * anyone who knows a victim's account UUID recover their balance.
   *
   * Account balances come from the ledger's `balanceAfter`, i.e. the state as
   * of this transfer, so replays stay deterministic.
   */
  private present(row: any, callerId: string) {
    const txs: any[] = row.transactions ?? [];
    const debit = txs.find((t: any) => t.type === 'DEBIT');
    const credit = txs.find((t: any) => t.type === 'CREDIT');
    const sourceOwned = row.source.userId === callerId;
    const destOwned = row.dest.userId === callerId;

    const sourceBalance = debit ? debit.balanceAfter : row.source.balance;
    const destBalance = credit ? credit.balanceAfter : row.dest.balance;

    const ownAccount = (a: any, balance: unknown) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      balance: Number(balance),
    });
    const counterparty = (a: any) => ({ id: a.id, currency: a.currency });

    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      amount: Number(row.amount),
      status: row.status,
      description: row.description ?? null,
      createdAt: row.createdAt,
      source: sourceOwned
        ? ownAccount(row.source, sourceBalance)
        : counterparty(row.source),
      dest: destOwned
        ? ownAccount(row.dest, destBalance)
        : counterparty(row.dest),
      // Same keys on every row so clients can rely on the shape; fields that
      // belong to a counterparty account are null rather than absent.
      transactions: txs.map((t: any) => {
        // A row is "ours" if it sits on ANY account the caller owns. Checking
        // only the source would wrongly redact the credit row of a transfer
        // between the caller's own two accounts.
        const own =
          (sourceOwned && t.accountId === row.source.id) ||
          (destOwned && t.accountId === row.dest.id);
        return {
          id: t.id,
          accountId: t.accountId,
          type: t.type,
          amount: Number(t.amount),
          balanceAfter: own ? Number(t.balanceAfter) : null,
          description: own ? t.description : null,
          category: t.category,
          createdAt: t.createdAt,
        };
      }),
    };
  }
}
