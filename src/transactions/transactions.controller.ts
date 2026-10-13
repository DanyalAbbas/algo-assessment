import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly prisma: PrismaService) {}

  // Transaction history across all of a user's accounts (or one account),
  // newest first. Returns ledger entries with their running balanceAfter.
  @Get()
  async list(
    @CurrentUser() user: { id: string },
    @Query('accountId') accountId?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit = 50,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ) {
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const safeOffset = Math.max(offset, 0);

    const where = {
      account: { userId: user.id },
      ...(accountId ? { accountId } : {}),
    };

    const [total, transactions] = await this.prisma.$transaction([
      this.prisma.transaction.count({ where }),
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: cappedLimit,
        skip: safeOffset,
        select: {
          id: true,
          accountId: true,
          type: true,
          amount: true,
          balanceAfter: true,
          description: true,
          category: true,
          transferId: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      total,
      limit: cappedLimit,
      offset: safeOffset,
      transactions: transactions.map((t) => ({
        ...t,
        amount: Number(t.amount),
        balanceAfter: Number(t.balanceAfter),
      })),
    };
  }
}
