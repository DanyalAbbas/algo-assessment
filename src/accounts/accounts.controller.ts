import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateAccountDto } from './dto/create-account.dto';

@UseGuards(JwtAuthGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateAccountDto) {
    return this.accounts
      .create(user.id, dto)
      .then((a) => AccountsService.serialize(a));
  }

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    const accounts = await this.accounts.listForUser(user.id);
    return accounts.map((a) => AccountsService.serialize(a));
  }

  @Get(':id/balance')
  async balance(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const account = await this.accounts.getBalance(user.id, id);
    return AccountsService.serialize(account);
  }
}
