import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CATEGORIES } from './categories';
import { CorrectionsService } from './corrections.service';
import { IsIn, IsString, MaxLength } from 'class-validator';

class CorrectCategoryDto {
  // Constrained to the canonical category set. This bounds stored data and
  // stops untrusted text being interpolated verbatim into the LLM prompt
  // (prompt injection) or echoed as a category downstream.
  @IsString()
  @MaxLength(50)
  @IsIn(CATEGORIES, {
    message: `correctedCategory must be one of: ${CATEGORIES.join(', ')}`,
  })
  correctedCategory: string;
}

@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post(':id/category')
  correct(
    @CurrentUser() user: { id: string },
    @Param('id') transactionId: string,
    @Body() dto: CorrectCategoryDto,
  ) {
    return this.corrections.correct(
      user.id,
      transactionId,
      dto.correctedCategory,
    );
  }

  // Categorize now and wait for the result (background is the default path).
  @Post(':id/categorize')
  categorizeNow(
    @CurrentUser() user: { id: string },
    @Param('id') transactionId: string,
  ) {
    return this.corrections.categorizeNow(user.id, transactionId);
  }

  @Get('corrections')
  list(@CurrentUser() user: { id: string }) {
    return this.corrections.listCorrections(userId(user));
  }
}

function userId(user: { id: string }) {
  return user.id;
}
