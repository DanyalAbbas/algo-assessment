/**
 * Regression tests for the authentication/session security fixes.
 * Runs against the disposable test database (same setup as transfers.e2e-spec).
 *
 * Covers:
 *  - Fail-fast JWT secret validation (no hardcoded fallback).
 *  - Concurrent refresh-token rotation is compare-and-swap (only one winner).
 *  - Sequential rotation chain works; reuse after rotation is rejected.
 *  - Transfer responses never leak internal userId values.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://app:app@localhost:5432/algo_assessment_test';
delete process.env.GROQ_API_KEY;
// Raise per-route throttles for the suite (defaults stay strict in production).
process.env.AUTH_LOGIN_RATE_LIMIT = '100000';
process.env.AUTH_REFRESH_RATE_LIMIT = '100000';
process.env.THROTTLE_LIMIT = '100000';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JwtSecretValidator } from '../src/auth/jwt-secret.validator';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(60_000);

describe('Auth security regressions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seq = 0;
  const uniq = (p: string) =>
    `${p}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}`;

  // The test database is not seeded, so register a dedicated user per suite.
  let aliceEmail: string;
  const alicePassword = 'password123';

  async function registerUser(email: string) {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: alicePassword, name: 'Auth Tester' })
      .expect(201);
  }

  async function login(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: alicePassword })
      .expect(201);
    return res.body as { accessToken: string; refreshToken: string };
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
    aliceEmail = uniq('auth-alice') + '@test.local';
    await registerUser(aliceEmail);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('JWT secret fail-fast validation', () => {
    it('rejects a missing secret', () => {
      const validator = app.get(JwtSecretValidator);
      const original = process.env.JWT_SECRET;
      process.env.JWT_SECRET = '';
      expect(() => validator.validateOrThrow()).toThrow(
        /at least 32 characters/,
      );
      if (original !== undefined) process.env.JWT_SECRET = original;
    });

    it('rejects the previous dev-secret fallback', () => {
      const validator = app.get(JwtSecretValidator);
      const original = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'dev-secret';
      expect(() => validator.validateOrThrow()).toThrow();
      if (original !== undefined) process.env.JWT_SECRET = original;
    });

    it('rejects the documented placeholder secret', () => {
      const validator = app.get(JwtSecretValidator);
      const original = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'change-me-in-production-use-long-random-string';
      expect(() => validator.validateOrThrow()).toThrow(/placeholder/);
      if (original !== undefined) process.env.JWT_SECRET = original;
    });

    it('accepts a high-entropy secret', () => {
      const validator = app.get(JwtSecretValidator);
      const original = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'a'.repeat(48) + 'Xy9$randomlookingentropy';
      expect(validator.validateOrThrow()).toBeTruthy();
      if (original !== undefined) process.env.JWT_SECRET = original;
    });
  });

  describe('refresh token rotation', () => {
    async function loginSession() {
      return login(aliceEmail);
    }

    it('rotates sequentially and rejects reuse of the rotated token', async () => {
      const { refreshToken } = await loginSession();

      const first = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(201);
      expect(first.body.accessToken).toBeTruthy();
      expect(first.body.refreshToken).not.toBe(refreshToken);

      // Chained refresh with the new token works.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: first.body.refreshToken })
        .expect(201);

      // Replaying the very first (now revoked) token is rejected.
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(401);
    });

    it('allows exactly one winner under concurrent rotation (compare-and-swap)', async () => {
      const { refreshToken } = await loginSession();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(app.getHttpServer())
            .post('/auth/refresh')
            .send({ refreshToken }),
        ),
      );

      const ok = responses.filter((r) => r.status === 201);
      const rejected = responses.filter((r) => r.status === 401);
      // Exactly one rotation succeeds; the rest are treated as reuse.
      expect(ok).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const r of rejected) {
        expect(r.body.message).toMatch(/reuse detected/i);
      }
    });

    it('rejects an invalid/unknown refresh token', async () => {
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'not-a-real-token-value' })
        .expect(401);
    });

    it('logout revokes the refresh token', async () => {
      const { refreshToken } = await loginSession();
      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refreshToken })
        .expect(201);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(401);
    });
  });

  describe('counterparty disclosure (regressions)', () => {
    async function twoFundedUsers() {
      const bobEmail = uniq('auth-bob') + '@test.local';
      await registerUser(bobEmail);
      const alice = await login(aliceEmail);
      const bob = await login(bobEmail);
      const aliceAcct = (
        await request(app.getHttpServer())
          .get('/accounts')
          .set('Authorization', `Bearer ${alice.accessToken}`)
          .expect(200)
      ).body[0];
      const bobAcct = (
        await request(app.getHttpServer())
          .get('/accounts')
          .set('Authorization', `Bearer ${bob.accessToken}`)
          .expect(200)
      ).body[0];
      await prisma.account.update({
        where: { id: aliceAcct.id },
        data: { balance: 100_000n },
      });
      return { alice, bob, aliceAcct, bobAcct };
    }

    it('never exposes the counterparty balance on a fresh transfer', async () => {
      const { alice, aliceAcct, bobAcct } = await twoFundedUsers();
      const key = uniq('counterparty');
      const body = {
        sourceAccountId: aliceAcct.id,
        destAccountId: bobAcct.id,
        amount: 1,
        idempotencyKey: key,
      };
      const fresh = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send(body)
        .expect(201);

      // Own account: full detail.
      expect(fresh.body.source).toHaveProperty('balance');
      // Counterparty: identifier + currency only.
      expect(fresh.body.dest).not.toHaveProperty('balance');
      expect(fresh.body.dest).not.toHaveProperty('name');
      expect(Object.keys(fresh.body.dest).sort()).toEqual(['currency', 'id']);
      expect(JSON.stringify(fresh.body)).not.toContain('userId');

      // Replay path must be equally strict.
      const replay = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send(body)
        .expect(201);
      expect(replay.body.replayed).toBe(true);
      expect(JSON.stringify(replay.body)).not.toContain('userId');
      expect(replay.body.dest).not.toHaveProperty('balance');
    });

    it('still shows full detail when the destination is the caller own account', async () => {
      const { alice, aliceAcct } = await twoFundedUsers();
      const second = await request(app.getHttpServer())
        .post('/accounts')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ name: 'Second' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          sourceAccountId: aliceAcct.id,
          destAccountId: second.body.id,
          amount: 5,
          idempotencyKey: uniq('self-owned'),
        })
        .expect(201);

      expect(res.body.dest).toHaveProperty('balance');
      expect(res.body.dest.name).toBe('Second');
    });

    it('does not leak another users transfer via idempotency-key probing', async () => {
      const { alice, bob, aliceAcct, bobAcct } = await twoFundedUsers();
      const key = uniq('oracle-probe');
      await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          sourceAccountId: aliceAcct.id,
          destAccountId: bobAcct.id,
          amount: 10,
          idempotencyKey: key,
        })
        .expect(201);

      // Bob reusing Alice's key must be treated as a brand-new request
      // (no existence oracle): he lacks ownership of the source account.
      const res = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .send({
          sourceAccountId: bobAcct.id,
          destAccountId: aliceAcct.id,
          amount: 10,
          idempotencyKey: key,
        });
      // Either rejected for ownership, or (if funded) he never sees Alice data.
      expect(res.body.source?.id).not.toBe(aliceAcct.id);
      expect(JSON.stringify(res.body)).not.toContain(aliceAcct.userId ?? 'x');
    });
  });

  describe('information disclosure', () => {
    it('does not leak userId in transfer responses', async () => {
      const bobEmail = uniq('auth-bob') + '@test.local';
      await registerUser(bobEmail);

      const alice = await login(aliceEmail);
      const bob = await login(bobEmail);

      const aliceAcct = await request(app.getHttpServer())
        .get('/accounts')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .expect(200);
      const bobAcct = await request(app.getHttpServer())
        .get('/accounts')
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .expect(200);

      // Fund the sender directly (no deposit endpoint by design).
      await prisma.account.update({
        where: { id: aliceAcct.body[0].id },
        data: { balance: 100_000n },
      });

      const transfer = await request(app.getHttpServer())
        .post('/transfers')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          sourceAccountId: aliceAcct.body[0].id,
          destAccountId: bobAcct.body[0].id,
          amount: 1,
          description: 'disclosure check',
          idempotencyKey: uniq('disclosure'),
        })
        .expect(201);

      expect(JSON.stringify(transfer.body)).not.toContain('userId');
      expect(transfer.body.source).not.toHaveProperty('userId');
      expect(transfer.body.dest).not.toHaveProperty('userId');
    });
  });
});
