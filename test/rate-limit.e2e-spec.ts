/**
 * Verifies global + per-route rate limiting is enforced.
 * Runs with deliberately LOW limits so the guard trips quickly.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://app:app@localhost:5432/algo_assessment_test';
delete process.env.GROQ_API_KEY;
process.env.AUTH_LOGIN_RATE_LIMIT = '3';
process.env.THROTTLE_LIMIT = '50';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

jest.setTimeout(60_000);

describe('Rate limiting', () => {
  let app: INestApplication;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('throttles repeated failed logins with 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrongpassword' });
      statuses.push(res.status);
    }
    // First N are 401 (invalid credentials), the rest are rate limited.
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
    expect(statuses).toContain(429);
  });
});
