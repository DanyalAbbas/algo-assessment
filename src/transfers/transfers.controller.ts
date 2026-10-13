import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { TransfersService } from './transfers.service';

@UseGuards(JwtAuthGuard)
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  async create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateTransferDto,
    @Headers('idempotency-key') headerKey?: string,
  ) {
    // The key may arrive in the body or the Idempotency-Key header. A blank
    // value counts as "not supplied" so the other channel is still honoured.
    const bodyKey = dto.idempotencyKey?.trim() || undefined;
    const headerIdempotencyKey = headerKey?.trim() || undefined;

    // When both channels carry a key they must agree. Silently preferring one
    // would let a client believe it is deduplicating by a key the server
    // ignored — the exact ambiguity idempotency exists to remove. Rejecting
    // here also means a conflicting request can never reach the service, so it
    // cannot replay an existing transfer or move funds.
    if (
      bodyKey !== undefined &&
      headerIdempotencyKey !== undefined &&
      bodyKey !== headerIdempotencyKey
    ) {
      throw new BadRequestException(
        'Conflicting idempotency keys: body.idempotencyKey and the Idempotency-Key header must match when both are supplied',
      );
    }

    const idempotencyKey = bodyKey || headerIdempotencyKey;
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new BadRequestException(
        'An idempotency key is required (body.idempotencyKey or Idempotency-Key header, min 8 chars)',
      );
    }

    // TransfersService owns both the money movement and the response
    // projection, so first runs and idempotent replays are guaranteed to be
    // shaped identically.
    const { transfer, replayed } = await this.transfers.execute(
      user.id,
      dto,
      idempotencyKey,
    );
    return { ...transfer, replayed };
  }
}
