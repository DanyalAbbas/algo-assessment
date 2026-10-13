/**
 * Regression tests for idempotency-key precedence in the transfer endpoint.
 *
 * The endpoint accepts the key from `body.idempotencyKey` OR the
 * `Idempotency-Key` header. When BOTH are supplied they must agree: silently
 * preferring one would let a client believe it is deduplicating by a key the
 * server ignored.
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

describe('Idempotency key precedence', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq = 0;

  const uniq = (p: string) =>
    `${p}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

  async function register(email: string) {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123', name: 'Keys' })
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

  /** Full snapshot of everything a conflicting request must not disturb. */
  const snapshot = async (ids: string[]) => ({
    balances: await Promise.all(ids.map((id) => balanceOf(id))),
    // Scoped to this test's own accounts: a global count would also move when
    // an unrelated suite writes to the shared test database.
    transfers: await prisma.transfer.count({
      where: {
        OR: [
          { sourceAccountId: ids[0] },
          { destAccountId: ids[0] },
          { sourceAccountId: ids[1] },
          { destAccountId: ids[1] },
        ],
      },
    }),
    ledger: await prisma.transaction.count({
      where: { accountId: { in: ids } },
    }),
  });

  function post(token: string, body: Record<string, unknown>, header?: string) {
    const req = request(app.getHttpServer())
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`);
    if (header !== undefined) req.set('Idempotency-Key', header);
    return req.send(body);
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

  // 1. Conflicting keys -> 400, nothing written.
  it('rejects conflicting body/header keys with 400 and changes no state', async () => {
    const before = await snapshot([src, dst]);

    const res = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 2500,
        idempotencyKey: uniq('body-key'),
      },
      uniq('header-key'),
    ).expect(400);

    expect(JSON.stringify(res.body.message)).toMatch(/conflicting/i);

    const after = await snapshot([src, dst]);
    expect(after.balances).toEqual(before.balances);
    expect(after.transfers).toBe(before.transfers);
    expect(after.ledger).toBe(before.ledger);
  });

  it('rejects a conflict even when the two keys are swapped duplicates', async () => {
    // Reproduces the reported shape: fixed body key, different header key.
    const res = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 100,
        idempotencyKey: 'body-key-0001',
      },
      'header-key-0002',
    ).expect(400);
    expect(JSON.stringify(res.body.message)).toMatch(/conflicting/i);
    expect(await balanceOf(src)).toBe(100_000);
  });

  // 2. Matching keys -> accepted (and the shared key still deduplicates).
  it('accepts matching body/header keys', async () => {
    const key = uniq('shared');
    const first = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 500,
        idempotencyKey: key,
      },
      key,
    ).expect(201);
    expect(first.body.replayed).toBe(false);

    // Same key on both channels again -> a genuine replay, not a new transfer.
    const second = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 500,
        idempotencyKey: key,
      },
      key,
    ).expect(201);
    expect(second.body.replayed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(await balanceOf(src)).toBe(99_500);
  });

  it('treats keys that differ only by surrounding whitespace as matching', async () => {
    const key = uniq('padded');
    const res = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 100,
        idempotencyKey: `  ${key}  `,
      },
      key,
    ).expect(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.idempotencyKey).toBe(key);
  });

  // 3. Single-channel keys keep working.
  it('accepts a body-only key', async () => {
    const res = await post(alice, {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 300,
      idempotencyKey: uniq('body-only'),
    }).expect(201);
    expect(res.body.replayed).toBe(false);
    expect(await balanceOf(src)).toBe(99_700);
  });

  it('accepts a header-only key', async () => {
    const key = uniq('header-only');
    const res = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 400,
      },
      key,
    ).expect(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.idempotencyKey).toBe(key);
    expect(await balanceOf(src)).toBe(99_600);
  });

  // 4. A mismatch is rejected even when a key would otherwise replay.
  it('rejects a mismatch instead of replaying an existing transfer', async () => {
    const existing = uniq('existing');
    const original = await post(alice, {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 1000,
      idempotencyKey: existing,
    }).expect(201);
    expect(await balanceOf(src)).toBe(99_000);

    const before = await snapshot([src, dst]);

    // body key would replay; header key is different -> must 400, not replay.
    const res = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 1000,
        idempotencyKey: existing,
      },
      uniq('other'),
    ).expect(400);
    expect(JSON.stringify(res.body.message)).toMatch(/conflicting/i);

    // Nothing replayed, nothing moved.
    const after = await snapshot([src, dst]);
    expect(after.balances).toEqual(before.balances);
    expect(after.transfers).toBe(before.transfers);

    // The original transfer is still intact and replayable on its own key.
    const replay = await post(alice, {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 1000,
      idempotencyKey: existing,
    }).expect(201);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.id).toBe(original.body.id);
    expect(await balanceOf(src)).toBe(99_000);
  });

  // Existing rules still enforced.
  it('still enforces the required-key and minimum-length rules', async () => {
    await post(alice, {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 100,
    }).expect(400);

    // Too short via header (body absent, so no conflict to trip first).
    await post(
      alice,
      { sourceAccountId: src, destAccountId: dst, amount: 100 },
      'short',
    ).expect(400);

    // Too short via body only.
    await post(alice, {
      sourceAccountId: src,
      destAccountId: dst,
      amount: 100,
      idempotencyKey: 'short',
    }).expect(400);

    expect(await balanceOf(src)).toBe(100_000);
  });

  it('treats a blank header as "not supplied" so a body-only key still works', async () => {
    const res = await post(
      alice,
      {
        sourceAccountId: src,
        destAccountId: dst,
        amount: 100,
        idempotencyKey: uniq('blank-header'),
      },
      '   ',
    ).expect(201);
    expect(res.body.replayed).toBe(false);
  });
});
