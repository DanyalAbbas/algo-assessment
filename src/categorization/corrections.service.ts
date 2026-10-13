import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CategorizationService } from './categorization.service';

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categorization: CategorizationService,
  ) {}

  /**
   * Categorize a single transaction now and await the result.
   *
   * Background categorization normally lands within a second or so; this is
   * the explicit, synchronous escape hatch — useful for a caller that needs a
   * category in hand immediately (and for demonstrating the correction
   * learning loop deterministically).
   */
  async categorizeNow(userId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, account: { userId } },
      select: { id: true },
    });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }
    const results = await this.categorization.categorizeTransactions([
      transactionId,
    ]);
    const category =
      results.get(transactionId) ??
      (
        await this.prisma.transaction.findUniqueOrThrow({
          where: { id: transactionId },
          select: { category: true },
        })
      ).category;
    return { transactionId, category };
  }

  // A user corrects the category of one of their transactions. We store the
  // correction so it can be injected into future LLM prompts as a few-shot
  // example (the learning loop).
  async correct(
    userId: string,
    transactionId: string,
    correctedCategory: string,
  ) {
    if (!correctedCategory || correctedCategory.trim().length === 0) {
      throw new BadRequestException('correctedCategory is required');
    }
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, account: { userId } },
      include: { account: { select: { userId: true } } },
    });
    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }

    const originalCategory = tx.category;
    const normalized = correctedCategory.trim();

    // If they "correct" it to the same category, there is nothing to learn —
    // skip creating a redundant correction record.
    if (originalCategory === normalized) {
      return {
        transactionId,
        category: normalized,
        correctionRecorded: false,
      };
    }

    await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id: transactionId },
        data: { category: normalized },
      }),
      this.prisma.categoryCorrection.create({
        data: {
          userId,
          transactionId,
          originalCategory,
          correctedCategory: normalized,
          description: tx.description,
        },
      }),
    ]);

    return {
      transactionId,
      category: normalized,
      correctionRecorded: true,
    };
  }

  async listCorrections(userId: string) {
    const corrections = await this.prisma.categoryCorrection.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return corrections.map((c) => ({
      id: c.id,
      transactionId: c.transactionId,
      description: c.description,
      originalCategory: c.originalCategory,
      correctedCategory: c.correctedCategory,
      createdAt: c.createdAt,
    }));
  }
}
