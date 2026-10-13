import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Spending insights computed on demand from the transaction ledger.
// All queries scope to the authenticated user's accounts.
@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string, month?: string) {
    const [monthly, byCategory, trend, unusual] = await Promise.all([
      this.monthlySummary(userId, month),
      this.spendingByCategory(userId, month),
      this.monthOverMonth(userId),
      this.unusualActivity(userId),
    ]);
    return {
      month: month ?? this.currentMonth(),
      monthly,
      byCategory,
      trend,
      unusual,
    };
  }

  private currentMonth(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // First and last day of a YYYY-MM month as UTC Date bounds.
  private monthBounds(month: string): { start: Date; end: Date } {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) {
      throw new BadRequestException('month must be formatted YYYY-MM');
    }
    const y = Number(match[1]);
    const m = Number(match[2]);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    return { start, end };
  }

  private async monthlySummary(userId: string, month?: string) {
    const target = month ?? this.currentMonth();
    const { start, end } = this.monthBounds(target);
    const rows = await this.prisma.transaction.findMany({
      where: {
        account: { userId },
        createdAt: { gte: start, lt: end },
      },
      select: { type: true, amount: true },
    });

    let totalSpent = 0;
    let totalIncome = 0;
    for (const r of rows) {
      const amt = Number(r.amount);
      if (r.type === 'DEBIT') totalSpent += amt;
      else totalIncome += amt;
    }
    return {
      month: target,
      totalSpentCents: totalSpent,
      totalIncomeCents: totalIncome,
      netCents: totalIncome - totalSpent,
      transactionCount: rows.length,
    };
  }

  private async spendingByCategory(userId: string, month?: string) {
    const target = month ?? this.currentMonth();
    const { start, end } = this.monthBounds(target);
    const grouped = await this.prisma.transaction.groupBy({
      by: ['category'],
      where: {
        account: { userId },
        type: 'DEBIT',
        createdAt: { gte: start, lt: end },
      },
      _sum: { amount: true },
      _count: true,
    });
    const total = grouped.reduce((s, g) => s + Number(g._sum.amount ?? 0), 0);
    return grouped
      .map((g) => {
        const cents = Number(g._sum.amount ?? 0);
        return {
          category: g.category,
          totalCents: cents,
          count: g._count,
          percentOfSpend:
            total > 0 ? Math.round((cents / total) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.totalCents - a.totalCents);
  }

  // Compare total spend this month vs last month to show a trend.
  private async monthOverMonth(userId: string) {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const lastMonthDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    const lastMonth = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;

    const [thisSum, lastSum] = await Promise.all([
      this.totalSpend(userId, thisMonth),
      this.totalSpend(userId, lastMonth),
    ]);
    const delta = thisSum - lastSum;
    const percentChange =
      lastSum > 0 ? Math.round((delta / lastSum) * 1000) / 10 : null;
    return {
      thisMonth: { month: thisMonth, totalSpentCents: thisSum },
      lastMonth: { month: lastMonth, totalSpentCents: lastSum },
      deltaCents: delta,
      percentChange,
      direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    };
  }

  private async totalSpend(userId: string, month: string): Promise<number> {
    const { start, end } = this.monthBounds(month);
    const agg = await this.prisma.transaction.aggregate({
      where: {
        account: { userId },
        type: 'DEBIT',
        createdAt: { gte: start, lt: end },
      },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  // Flag debits that are unusually large relative to the user's own history:
  // more than 2 standard deviations above their mean debit, with a minimum
  // sample size so early transactions don't all look "unusual".
  private async unusualActivity(userId: string) {
    const debits = await this.prisma.transaction.findMany({
      where: { account: { userId }, type: 'DEBIT' },
      select: {
        id: true,
        amount: true,
        description: true,
        category: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (debits.length < 10) {
      return {
        thresholdCents: null,
        items: [],
        note: 'Not enough history to detect unusual activity yet.',
      };
    }
    const amounts = debits.map((d) => Number(d.amount));
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance =
      amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    const threshold = mean + 2 * stdDev;

    const items = debits
      .filter((d) => Number(d.amount) > threshold)
      .slice(0, 10)
      .map((d) => ({
        id: d.id,
        amountCents: Number(d.amount),
        description: d.description,
        category: d.category,
        createdAt: d.createdAt,
      }));

    return {
      thresholdCents: Math.round(threshold),
      meanCents: Math.round(mean),
      stdDevCents: Math.round(stdDev),
      items,
      note:
        items.length > 0
          ? 'These transactions are more than 2 standard deviations above your average spend.'
          : 'No unusual spending detected in your recent history.',
    };
  }
}
