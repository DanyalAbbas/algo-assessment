/**
 * Regression tests for the reported transfer-engine defects.
 *
 *  1. Concurrent identical retries must REPLAY, not fail with
 *     "Insufficient funds", even when the first request drains the account.
 *  2. Idempotency payload comparison must include `description`
 *     (omitted / null / empty / whitespace-only are one canonical payload).
 *  3. Amounts that cannot round-trip exactly through JSON/JS must be rejected
 *     without touching balances or the ledger.
 *  7. First-run and replay responses must have the same shape and values.
 *
 * Runs against the disposable test database only.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://app:app@localhost:5432/algo_assessment_test';
delete process.env.GROQ_API_KEY;
process.env.AUTH_LOGIN_RATE_LIMIT = '100000';
process.env.AUTH_REFRESH_RATE_LIMIT = '100000';
process.env.THROTTLE_LIMIT = '100000';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120_000);

describe('Transfer engine regressions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq = 0;

  const uniq = (p: string) =>
    `${p}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

  async function register(email: string) {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123', name: 'Regression' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201);
    return res.body.accessToken as string;
  }

  async function firstAccount(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get('/accounts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body[0].id;
  }

  const setBalance = (id: string, cents: number) =>
    prisma.account.update({ where: { id }, data: { balance: BigInt(cents) } });

  const balanceOf = async (id: string) => {
    const a = await prisma.account.findUniqueOrThrow({ where: { id } });
    return Number(a.balance);
  };

  function transfer(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------
  // 1. Concurrent identical retry against a fully drained source
  // ---------------------------------------------------------------------
  it('replays (not 400) when a concurrent identical request drains the account', async () => {
    const alice = await register(uniq('alice') + '@test.local');
    const bob = await register(uniq('bob') + '@test.local');
    const src = await firstAccount(alice);
    const dst = await firstAccount(bob);

    // Alice holds EXACTLY the transfer amount, so whoever commits first
    // drains her account to zero. The loser must replay, not 400.
    await setBalance(src, 1000);
    await setBalance(dst, 0);

    const key = uniq('drained');
    const payload = {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 1000,
      description: 'drain test',
      idempotencyKey: key,
    };

    const [a, b] = await Promise.all([
      transfer(alice, payload),
      transfer(alice, payload),
    ]);

    // Both succeed, exactly one is a replay.
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const flags = [a.body.replayed, b.body.replayed].filter(Boolean);
    expect(flags).toHaveLength(1);

    // Same transfer returned to both callers.
    expect(a.body.id).toBe(b.body.id);

    // Money moved exactly once.
    expect(await balanceOf(src)).toBe(0);
    expect(await balanceOf(dst)).toBe(1000);
    expect(
      await prisma.transfer.count({ where: { idempotencyKey: key } }),
    ).toBe(1);

    // Exactly one ledger pair.
    const txs = await prisma.transaction.findMany({
      where: { transferId: a.body.id },
    });
    expect(txs).toHaveLength(2);
    expect(txs.filter((t) => t.type === 'DEBIT')).toHaveLength(1);
    expect(txs.filter((t) => t.type === 'CREDIT')).toHaveLength(1);
  });

  it('replays with a larger burst against a drained source, still moving funds once', async () => {
    const alice = await register(uniq('alice') + '@test.local');
    const bob = await register(uniq('bob') + '@test.local');
    const src = await firstAccount(alice);
    const dst = await firstAccount(bob);
    await setBalance(src, 500);
    await setBalance(dst, 0);

    const key = uniq('drained-burst');
    const payload = {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 500,
      idempotencyKey: key,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => transfer(alice, payload)),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    // Exactly one request created the transfer; the other seven replayed it.
    expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.replayed === true)).toHaveLength(7);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(await balanceOf(src)).toBe(0);
    expect(await balanceOf(dst)).toBe(500);
    expect(
      await prisma.transfer.count({ where: { idempotencyKey: key } }),
    ).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 2. description participates in the idempotency payload
  // ---------------------------------------------------------------------
  describe('description is part of the idempotent payload', () => {
    let alice: string;
    let bob: string;
    let src: string;
    let dst: string;

    beforeEach(async () => {
      alice = await register(uniq('alice') + '@test.local');
      bob = await register(uniq('bob') + '@test.local');
      src = await firstAccount(alice);
      dst = await firstAccount(bob);
      await setBalance(src, 100_000);
      await setBalance(dst, 0);
    });

    it('returns 409 when the description changes under the same key', async () => {
      const key = uniq('desc');
      const base = {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 500,
        idempotencyKey: key,
      };

      await transfer(alice, { ...base, description: 'Groceries' }).expect(201);

      const res = await transfer(alice, {
        ...base,
        description: 'Electronics',
      }).expect(409);
      expect(res.body.message).toMatch(/different payload/i);

      // Money moved only once despite the conflicting retry.
      expect(await balanceOf(src)).toBe(99_500);
    });

    it('replays when the description is identical', async () => {
      const key = uniq('desc-same');
      const base = {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 250,
        description: 'Same description',
        idempotencyKey: key,
      };
      const first = await transfer(alice, base).expect(201);
      const second = await transfer(alice, base).expect(201);
      expect(second.body.replayed).toBe(true);
      expect(second.body.id).toBe(first.body.id);
      expect(await balanceOf(src)).toBe(99_750);
    });

    it('treats omitted, empty and whitespace descriptions as one payload', async () => {
      const key = uniq('desc-canon');
      const base = {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 100,
        idempotencyKey: key,
      };

      // Original omits the description entirely -> stored canonically as null.
      const first = await transfer(alice, base).expect(201);
      expect(first.body.description).toBeNull();

      // Retry with empty string and with whitespace-only: same payload.
      const empty = await transfer(alice, {
        ...base,
        description: '',
      }).expect(201);
      expect(empty.body.replayed).toBe(true);

      const blank = await transfer(alice, {
        ...base,
        description: '   ',
      }).expect(201);
      expect(blank.body.replayed).toBe(true);
      expect(blank.body.id).toBe(first.body.id);

      // Only the ledger descriptions differ, never the money.
      expect(await balanceOf(src)).toBe(99_900);
      expect(
        await prisma.transfer.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
    });

    it('normalises surrounding whitespace on the stored description', async () => {
      const key = uniq('desc-trim');
      const base = {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 100,
        idempotencyKey: key,
      };
      const first = await transfer(alice, {
        ...base,
        description: '  Coffee  ',
      }).expect(201);
      expect(first.body.description).toBe('Coffee');

      // "Coffee" and "  Coffee  " canonicalise identically -> replay, not 409.
      const second = await transfer(alice, {
        ...base,
        description: 'Coffee',
      }).expect(201);
      expect(second.body.replayed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // 3. Unsafe integer amounts
  // ---------------------------------------------------------------------
  describe('unsafe integer amounts', () => {
    let alice: string;
    let bob: string;
    let src: string;
    let dst: string;

    beforeEach(async () => {
      alice = await register(uniq('alice') + '@test.local');
      bob = await register(uniq('bob') + '@test.local');
      src = await firstAccount(alice);
      dst = await firstAccount(bob);
      await setBalance(src, 100_000);
      await setBalance(dst, 0);
    });

    it('rejects 2^53 (9007199254740992) without moving money', async () => {
      const res = await transfer(alice, {
        sourceAccountId: src,
        destAccountId: dst,
        // 2^53 — the first integer that cannot round-trip through a double.
        amount: 9007199254740992,
        idempotencyKey: uniq('unsafe'),
      }).expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/MAX_SAFE_INTEGER/i);

      expect(await balanceOf(src)).toBe(100_000);
      expect(await balanceOf(dst)).toBe(0);
      // No ledger row was written for either account.
      expect(
        await prisma.transaction.count({
          where: { accountId: { in: [src, dst] } },
        }),
      ).toBe(0);
    });

    it('rejects a raw-JSON amount above 2^53 and leaves the ledger untouched', async () => {
      const key = uniq('unsafe-raw');
      // Send the literal digits 2^53+1. JSON.parse rounds it to 2^53, which is
      // still above MAX_SAFE_INTEGER and must therefore be refused — the point
      // being that no cent is silently altered.
      const res = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${alice}`)
        .set('Content-Type', 'application/json')
        .send(
          `{"sourceAccountId":"${src}","destAccountId":"${dst}","amount":9007199254740993,"idempotencyKey":"${key}"}`,
        )
        .expect(400);

      expect(JSON.stringify(res.body.message)).toMatch(/MAX_SAFE_INTEGER/i);
      expect(await balanceOf(src)).toBe(100_000);
      expect(await balanceOf(dst)).toBe(0);
      expect(
        await prisma.transfer.count({ where: { idempotencyKey: key } }),
      ).toBe(0);
    });

    it('accepts the largest safe integer boundary', async () => {
      // MAX_SAFE_INTEGER itself must still be allowed (the DB is BIGINT).
      await setBalance(src, Number.MAX_SAFE_INTEGER);
      const res = await transfer(alice, {
        sourceAccountId: src,
        destAccountId: dst,
        amount: Number.MAX_SAFE_INTEGER,
        idempotencyKey: uniq('safe-boundary'),
      }).expect(201);
      expect(res.body.amount).toBe(Number.MAX_SAFE_INTEGER);
      expect(await balanceOf(src)).toBe(0);
      expect(await balanceOf(dst)).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  // ---------------------------------------------------------------------
  // 7. First-run and replay responses have the same shape
  // ---------------------------------------------------------------------
  describe('first-run and replay responses match', () => {
    it('returns an identical shape and identical values on replay', async () => {
      const alice = await register(uniq('alice') + '@test.local');
      const bob = await register(uniq('bob') + '@test.local');
      const src = await firstAccount(alice);
      const dst = await firstAccount(bob);
      await setBalance(src, 50_000);
      await setBalance(dst, 0);

      const key = uniq('shape');
      const payload = {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 1234,
        description: 'shape check',
        idempotencyKey: key,
      };

      const first = await transfer(alice, payload).expect(201);

      // Move the balances AFTER the original transfer. A replay must still
      // report the state as of the transfer, not the drifted current balance,
      // otherwise the same request returns different data on each retry.
      await setBalance(src, 1_000);
      await setBalance(dst, 99_000);

      const replay = await transfer(alice, payload).expect(201);
      expect(replay.body.replayed).toBe(true);

      const firstBody: any = { ...first.body };
      const replayBody: any = { ...replay.body };
      delete firstBody.replayed;
      delete replayBody.replayed;

      expect(Object.keys(replayBody).sort()).toEqual(
        Object.keys(firstBody).sort(),
      );
      expect(replayBody).toEqual(firstBody);

      // Explicitly: same keys on every nested object, and documented values.
      expect(Object.keys(replayBody.source).sort()).toEqual(
        Object.keys(firstBody.source).sort(),
      );
      expect(Object.keys(replayBody.dest).sort()).toEqual(
        Object.keys(firstBody.dest).sort(),
      );
      expect(replayBody.source.balance).toBe(firstBody.source.balance);
      expect(replayBody.dest).toEqual(firstBody.dest);
      expect(replayBody.transactions).toHaveLength(2);
      expect(
        replayBody.transactions.map((t: any) => Object.keys(t).sort()),
      ).toEqual(firstBody.transactions.map((t: any) => Object.keys(t).sort()));

      // Still exactly one movement on record.
      expect(
        await prisma.transfer.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
    });

    it('shows BOTH ledger rows in full when transferring between own accounts', async () => {
      const alice = await register(uniq('alice') + '@test.local');
      const src = await firstAccount(alice);
      await setBalance(src, 50_000);

      // A second account owned by the SAME caller.
      const second = await request(app.getHttpServer())
        .post('/accounts')
        .set('Authorization', `Bearer ${alice}`)
        .send({ name: 'Savings' })
        .expect(201);

      const res = await transfer(alice, {
        sourceAccountId: src,
        destAccountId: second.body.id,
        amount: 250,
        idempotencyKey: uniq('self-owned'),
      }).expect(201);

      // The destination object has full detail...
      expect(res.body.dest).toHaveProperty('balance');
      expect(res.body.dest.name).toBe('Savings');
      // ...and BOTH ledger rows are the caller's own, so neither may be
      // redacted. Regression: previously the credit row was nulled out
      // because ownership was only checked against the source.
      const rows = res.body.transactions;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.balanceAfter).not.toBeNull();
        expect(typeof row.balanceAfter).toBe('number');
        expect(row.description).not.toBeNull();
      }
      const credit = rows.find((t: any) => t.type === 'CREDIT');
      expect(credit.balanceAfter).toBe(250);
      const debit = rows.find((t: any) => t.type === 'DEBIT');
      expect(debit.balanceAfter).toBe(49_750);
    });

    it('keeps the documented counterparty redaction on BOTH paths', async () => {
      const alice = await register(uniq('alice') + '@test.local');
      const bob = await register(uniq('bob') + '@test.local');
      const src = await firstAccount(alice);
      const dst = await firstAccount(bob);
      await setBalance(src, 10_000);
      await setBalance(dst, 0);

      const key = uniq('redact');
      const payload = {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 100,
        idempotencyKey: key,
      };

      const first = await transfer(alice, payload).expect(201);
      const replay = await transfer(alice, payload).expect(201);

      for (const body of [first.body, replay.body]) {
        // Own account: full detail.
        expect(body.source).toHaveProperty('balance');
        expect(body.source).toHaveProperty('name');
        // Counterparty: id + currency only, never balance/name/userId.
        expect(Object.keys(body.dest).sort()).toEqual(['currency', 'id']);
        expect(JSON.stringify(body)).not.toContain('userId');
        // Counterparty ledger row must not leak balance or description.
        const counterRow = body.transactions.find(
          (t: any) => t.accountId === dst,
        );
        expect(counterRow.balanceAfter).toBeNull();
        expect(counterRow.description).toBeNull();
        // But the shape is identical on every row.
        for (const t of body.transactions) {
          expect(Object.keys(t).sort()).toEqual([
            'accountId',
            'amount',
            'balanceAfter',
            'category',
            'createdAt',
            'description',
            'id',
            'type',
          ]);
        }
      }
    });
  });
});
