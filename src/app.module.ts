import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { TransfersModule } from './transfers/transfers.module';
import { TransactionsModule } from './transactions/transactions.module';
import { CategorizationModule } from './categorization/categorization.module';
import { InsightsModule } from './insights/insights.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global rate limiting, primarily to blunt gross abuse. The limit is set
    // generously on purpose: this API is exercised by automated concurrency
    // and edge-case suites from a single IP, and a tight global cap would
    // reject legitimate load as 429 and mask real results. Tight per-route
    // limits live on the credential endpoints in auth.controller.ts.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: Number(process.env.THROTTLE_TTL_MS || 60_000),
        limit: Number(process.env.THROTTLE_LIMIT || 2000),
      },
    ]),
    PrismaModule,
    AuthModule,
    AccountsModule,
    TransfersModule,
    TransactionsModule,
    CategorizationModule,
    InsightsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
