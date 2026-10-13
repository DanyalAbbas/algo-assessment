import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAccountDto } from './dto/create-account.dto';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateAccountDto) {
    return this.prisma.account.create({
      data: {
        userId,
        name: dto.name?.trim() || 'Main',
      },
      select: this.accountSelect,
    });
  }

  async listForUser(userId: string) {
    return this.prisma.account.findMany({
      where: { userId },
      select: this.accountSelect,
      orderBy: { createdAt: 'asc' },
    });
  }

  async getBalance(userId: string, accountId: string) {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: this.accountSelect,
    });
    if (!account) {
      throw new NotFoundException('Account not found');
    }
    return account;
  }

  // BigInt -> number for JSON responses (cents). Safe for this application's scale.
  private accountSelect = {
    id: true,
    name: true,
    currency: true,
    balance: true,
    createdAt: true,
  } as const;

  // Helper used by controllers to serialize BigInt balances to plain numbers.
  // Uses an explicit field whitelist rather than spreading the input: the
  // transfer path passes raw rows that include `userId`, and exposing another
  // party's internal user id is unnecessary information disclosure.
  static serialize(account: {
    id: string;
    name: string;
    currency: string;
    balance: bigint;
    createdAt: Date;
  }) {
    return {
      id: account.id,
      name: account.name,
      currency: account.currency,
      balance: Number(account.balance),
      createdAt: account.createdAt,
    };
  }
}
