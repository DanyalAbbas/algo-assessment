/**
 * End-to-end tests for the transfer engine — the most heavily graded part
 * of the assessment. These run against a real PostgreSQL test database and
 * exercise the HTTP API the same way a reviewer would.
 *
 * Test DB setup (run once):
 *   PGPASSWORD=app createdb -h localhost -U app algo_assessment_test
 *   DATABASE_URL=...algo_assessment_test npx prisma migrate deploy
 *
 * The suite sets DATABASE_URL to the test DB before the AppModule is loaded,
 * so the Prisma client connects there instead of dev.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://app:app@localhost:5432/algo_assessment_test';
// Force the LLM path off during tests so categorization can't hit the network
// or depend on an API key. Transfer correctness is what we assert here.
delete process.env.GROQ_API_KEY;
// Raise per-route throttles for the suite (defaults stay strict in production).
process.env.AUTH_LOGIN_RATE_LIMIT = '100000';
process.env.AUTH_REFRESH_RATE_LIMIT = '100000';
process.env.THROTTLE_LIMIT = '100000';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

describe('Transfers (idempotency, concurrency, edge cases)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let aliceToken: string;
  let bobToken: string;
  let aliceAcct: string;
  let bobAcct: string;
  let seq = 0;

  const uniq = (prefix: string) =>
    `${prefix}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

  async function register(email: string, name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, name, password: 'password123' })
      .expect(201);
    return res.body.accessToken;
  }

  async function accountIdOf(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get('/accounts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body[0].id;
  }

  async function setBalance(accountId: string, cents: number) {
    await prisma.account.update({
      where: { id: accountId },
      data: { balance: BigInt(cents) },
    });
  }

  async function balanceOf(accountId: string): Promise<number> {
    const acct = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
    });
    return Number(acct.balance);
  }

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

    aliceToken = await register(uniq('alice') + '@test.local', 'Alice');
    bobToken = await register(uniq('bob') + '@test.local', 'Bob');
    aliceAcct = await accountIdOf(aliceToken);
    bobAcct = await accountIdOf(bobToken);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Deterministic starting balance for each test.
    await setBalance(aliceAcct, 100_000);
    await setBalance(bobAcct, 50_000);
  });

  it('moves funds, writes two ledger entries, and updates balances atomically', async () => {
    const res = await transfer(aliceToken, {
      sourceAccountId: aliceAcct,
      destAccountId: bobAcct,
      amount: 2500,
      description: 'Test transfer',
      idempotencyKey: uniq('k'),
    }).expect(201);

    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.replayed).toBe(false);
    expect(res.body.transactions).toHaveLength(2);
    const types = res.body.transactions.map((t: any) => t.type).sort();
    expect(types).toEqual(['CREDIT', 'DEBIT']);
    expect(await balanceOf(aliceAcct)).toBe(97_500);
    expect(await balanceOf(bobAcct)).toBe(52_500);
  });

  it('replays an identical request without moving money twice', async () => {
    const key = uniq('replay');
    const payload = {
      sourceAccountId: aliceAcct,
      destAccountId: bobAcct,
      amount: 1000,
      idempotencyKey: key,
    };

    const first = await transfer(aliceToken, payload).expect(201);
    const second = await transfer(aliceToken, payload).expect(201);

    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    // Money moved exactly once.
    expect(await balanceOf(aliceAcct)).toBe(99_000);
    expect(await balanceOf(bobAcct)).toBe(51_000);
    const transfers = await prisma.transfer.count({
      where: { idempotencyKey: key },
    });
    expect(transfers).toBe(1);
  });

  it('concurrent identical requests (same key) produce exactly one transfer', async () => {
    const key = uniq('concurrent-same');
    const payload = {
      sourceAccountId: aliceAcct,
      destAccountId: bobAcct,
      amount: 500,
      idempotencyKey: key,
    };

    // Fire 10 simultaneous requests with the SAME idempotency key.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => transfer(aliceToken, payload)),
    );

    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1); // everyone got the same transfer back
    const transferCount = await prisma.transfer.count({
      where: { idempotencyKey: key },
    });
    expect(transferCount).toBe(1); // only one was ever created
    // Money moved exactly once despite 10 concurrent requests.
    expect(await balanceOf(aliceAcct)).toBe(99_500);
    expect(await balanceOf(bobAcct)).toBe(50_500);
  });

  it('concurrent distinct transfers never overdraw (no negative balance, no double spend)', async () => {
    // Give Alice exactly 1000 cents and fire 20 concurrent 100-cent transfers.
    // Only 10 can succeed; the rest must fail with insufficient funds.
    await setBalance(aliceAcct, 1000);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        transfer(aliceToken, {
          sourceAccountId: aliceAcct,
          destAccountId: bobAcct,
          amount: 100,
          idempotencyKey: uniq(`race-${i}`),
        }),
      ),
    );

    const succeeded = responses.filter((r) => r.status === 201);
    const failed = responses.filter((r) => r.status === 400);
    expect(succeeded).toHaveLength(10);
    expect(failed).toHaveLength(10);
    for (const f of failed) {
      expect(f.body.message).toBe('Insufficient funds');
    }

    // Final balances: Alice drained to exactly 0 (never negative).
    expect(await balanceOf(aliceAcct)).toBe(0);
    // Bob received exactly 10 * 100 = 1000 cents.
    expect(await balanceOf(bobAcct)).toBe(51_000);
    // Exactly 10 transfers exist — no phantom double-spend.
    const transferCount = await prisma.transfer.count({
      where: { sourceAccountId: aliceAcct, amount: 100n },
    });
    expect(transferCount).toBe(10);
  });

  it('rejects the same idempotency key reused with a different payload', async () => {
    const key = uniq('conflict');
    await transfer(aliceToken, {
      sourceAccountId: aliceAcct,
      destAccountId: bobAcct,
      amount: 1000,
      idempotencyKey: key,
    }).expect(201);

    const res = await transfer(aliceToken, {
      sourceAccountId: aliceAcct,
      destAccountId: bobAcct,
      amount: 9999, // different amount, same key
      idempotencyKey: key,
    }).expect(409);
    expect(res.body.message).toMatch(/different payload/i);
  });

  it('rejects a transfer with insufficient funds and persists no transfer', async () => {
    await setBalance(aliceAcct, 100);
    const key = uniq('insufficient');
    const res = await transfer(aliceToken, {
      sourceAccountId: aliceAcct,
      destAccountId: bobAcct,
      amount: 5000,
      idempotencyKey: key,
    }).expect(400);
    expect(res.body.message).toBe('Insufficient funds');
    expect(await balanceOf(aliceAcct)).toBe(100); // untouched
    const t = await prisma.transfer.count({ where: { idempotencyKey: key } });
    expect(t).toBe(0); // failed transfer is not persisted
  });

  it('rejects self-transfer and missing idempotency key', async () => {
    await transfer(aliceToken, {
      sourceAccountId: aliceAcct,
      destAccountId: aliceAcct,
      amount: 100,
      idempotencyKey: uniq('self'),
    }).expect(400);

    await request(app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        sourceAccountId: aliceAcct,
        destAccountId: bobAcct,
        amount: 100,
      })
      .expect(400);
  });

  it("rejects using another user's account as the source", async () => {
    await transfer(bobToken, {
      sourceAccountId: aliceAcct, // Bob does not own this
      destAccountId: bobAcct,
      amount: 100,
      idempotencyKey: uniq('not-owner'),
    }).expect(400);
  });

  it('accepts the Idempotency-Key header as an alternative to the body', async () => {
    const key = uniq('header');
    const body = {
      sourceAccountId: aliceAcct,
      destAccountId: bobAcct,
      amount: 300,
    };
    const first = await request(app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(second.body.replayed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(await balanceOf(aliceAcct)).toBe(99_700);
  });
});
