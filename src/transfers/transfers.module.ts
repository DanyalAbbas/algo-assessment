import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { CategorizationModule } from '../categorization/categorization.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [AccountsModule, CategorizationModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
