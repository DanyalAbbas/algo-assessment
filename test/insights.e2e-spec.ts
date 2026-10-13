/**
 * Regression tests for insights month-parameter validation (issue 6).
 * Runs against the disposable test database only.
 */
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://app:app@localhost:5432/algo_assessment_test';
delete process.env.GROQ_API_KEY;
process.env.THROTTLE_LIMIT = '100000';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

jest.setTimeout(60_000);

describe('Insights month validation', () => {
  let app: INestApplication;
  let token: string;
  let seq = 0;

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

    const email = `insights-${Date.now()}-${seq++}@test.local`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123', name: 'Insights' })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const insights = (month?: string) => {
    const url = month === undefined ? '/insights' : `/insights?month=${month}`;
    return request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${token}`);
  };

  it('accepts a valid month', async () => {
    const res = await insights('2026-10').expect(200);
    expect(res.body.month).toBe('2026-10');
  });

  it('accepts January and December boundary months', async () => {
    await insights('2026-01').expect(200);
    await insights('2026-12').expect(200);
    await insights('2024-02').expect(200);
  });

  it('defaults to the current UTC month when omitted', async () => {
    const res = await insights().expect(200);
    expect(res.body.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it.each([
    ['abc', 'non-numeric'],
    ['', 'empty'],
    ['2026', 'year only'],
    ['2026-1', 'unpadded month'],
    ['2026-100', 'three-digit month'],
    ['2026-10-01', 'full date'],
    ['10-2026', 'reversed'],
    ['null', 'literal null'],
    ['NaN', 'NaN'],
    ['2026-13', 'month 13'],
    ['2026-00', 'month 00'],
    ['2026-99', 'month 99'],
    ['-2026-10', 'negative year'],
  ])('rejects month=%p (%s) with 400', async (month) => {
    await insights(month).expect(400);
  });
});
