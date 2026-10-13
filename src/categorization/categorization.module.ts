import { Module } from '@nestjs/common';
import { CategorizationService } from './categorization.service';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';

@Module({
  controllers: [CorrectionsController],
  providers: [CategorizationService, CorrectionsService],
  exports: [CategorizationService],
})
export class CategorizationModule {}
