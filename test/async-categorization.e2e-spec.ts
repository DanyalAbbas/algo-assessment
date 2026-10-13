/**
 * Tests for the asynchronous categorization architecture.
 *
 * Categorization is derived data and is deliberately kept OFF the
 * money-movement path: a transfer commits and returns without waiting on the
 * LLM. A background worker drains the queue, and an explicit endpoint lets a
 * caller categorize synchronously when it needs a category in hand.
 *
 * Runs against the disposable test database with the LLM disabled (no
 * GROQ_API_KEY), so these assert the ORCHESTRATION, not model output.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://app:app@localhost:5432/algo_assessment_test';
delete process.env.GROQ_API_KEY;
process.env.AUTH_LOGIN_RATE_LIMIT = '100000';
process.env.THROTTLE_LIMIT = '100000';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120_000);

describe('Async categorization', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq = 0;

  const uniq = (p: string) =>
    `${p}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

  async function register(email: string) {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123', name: 'Async' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201);
    return res.body.accessToken as string;
  }

  const firstAccount = async (token: string) =>
    (
      await request(app.getHttpServer())
        .get('/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body[0].id;

  const setBalance = (id: string, cents: number) =>
    prisma.account.update({ where: { id }, data: { balance: BigInt(cents) } });

  const categoryInDb = async (id: string) =>
    (await prisma.transaction.findUniqueOrThrow({ where: { id } })).category;

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

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${alice}`)
      .send(body);

  it('classifies a description-less transfer as Transfers without calling the LLM', async () => {
    const res = await post({
      sourceAccountId: src,
      destAccountId: dst,
      amount: 100,
      idempotencyKey: uniq('nodesc'),
    }).expect(201);

    // Both rows are already categorised at commit time.
    for (const t of res.body.transactions) {
      expect(t.category).toBe('Transfers');
    }
    // And persisted that way.
    for (const t of res.body.transactions) {
      expect(await categoryInDb(t.id)).toBe('Transfers');
    }
  });

  it('does not block the transfer on a described transaction (returns Uncategorized)', async () => {
    const started = Date.now();
    const res = await post({
      sourceAccountId: src,
      destAccountId: dst,
      amount: 100,
      description: 'Lunch with a client',
      idempotencyKey: uniq('desc'),
    }).expect(201);
    const elapsed = Date.now() - started;

    // Money moved and the response came back without waiting on an LLM
    // (none is configured here, so any await would be an immediate no-op —
    // the assertion that matters is that the row is queued, not finished).
    expect(res.body.transactions[0].category).toBe('Uncategorized');
    expect(elapsed).toBeLessThan(5000);
    expect(await balanceOf(src)).toBe(99_900);
  });

  it('categorizes on demand via POST /transactions/:id/categorize', async () => {
    const res = await post({
      sourceAccountId: src,
      destAccountId: dst,
      amount: 100,
      description: 'Train ticket',
      idempotencyKey: uniq('ondemand'),
    }).expect(201);
    const txId = res.body.transactions.find((t: any) => t.type === 'DEBIT').id;

    const out = await request(app.getHttpServer())
      .post(`/transactions/${txId}/categorize`)
      .set('Authorization', `Bearer ${alice}`)
      .expect(201);

    expect(out.body.transactionId).toBe(txId);
    // With no LLM configured the safe fallback is used, and it is persisted.
    expect(out.body.category).toBeTruthy();
    expect(await categoryInDb(txId)).toBe(out.body.category);
  });

  it('refuses to categorize another user transaction', async () => {
    const res = await post({
      sourceAccountId: src,
      destAccountId: dst,
      amount: 100,
      description: 'Alice thing',
      idempotencyKey: uniq('owned'),
    }).expect(201);
    const txId = res.body.transactions.find((t: any) => t.type === 'DEBIT').id;

    // Bob must not be able to trigger/observe Alice's transaction.
    await request(app.getHttpServer())
      .post(`/transactions/${txId}/categorize`)
      .set('Authorization', `Bearer ${bob}`)
      .expect(404);
  });

  it('is idempotent-safe: a replay does not re-queue or move money twice', async () => {
    const key = uniq('replay-async');
    const payload = {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 250,
      description: 'Coffee',
      idempotencyKey: key,
    };
    const first = await post(payload).expect(201);
    const second = await post(payload).expect(201);

    expect(second.body.replayed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(await balanceOf(src)).toBe(99_750);
    expect(
      await prisma.transfer.count({ where: { idempotencyKey: key } }),
    ).toBe(1);
  });

  async function balanceOf(id: string): Promise<number> {
    return Number(
      (await prisma.account.findUniqueOrThrow({ where: { id } })).balance,
    );
  }
});
