import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InsightsService } from './insights.service';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  get(@CurrentUser() user: { id: string }, @Query() query: InsightsQueryDto) {
    return this.insights.summary(user.id, query.month);
  }
}
