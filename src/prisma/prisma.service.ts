import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Size the connection pool explicitly.
 *
 * Prisma derives its pool from the host CPU count, which on a small/shared
 * cloud instance is tiny (often 3). A burst of concurrent transfers then has
 * to queue, and Prisma's default `maxWait` of 2s turns the queue into hard
 * failures. A deliberate, modest pool plus the generous `maxWait` configured
 * on the transfer transaction makes bursts queue instead of erroring.
 *
 * Overridable with DATABASE_POOL_SIZE.
 */
function poolSize(): number {
  const raw = process.env.DATABASE_POOL_SIZE;
  const n = raw === undefined || raw === '' ? 10 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

function withPoolSize(url: string | undefined): string | undefined {
  if (!url) return url;
  // Don't override an explicit limit already present in the URL.
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${poolSize()}`;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      datasources: { db: { url: withPoolSize(process.env.DATABASE_URL) } },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
