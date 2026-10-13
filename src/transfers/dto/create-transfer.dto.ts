import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateTransferDto {
  @IsUUID()
  sourceAccountId: string;

  @IsUUID()
  destAccountId: string;

  // Amount in minor units (cents). Must be a positive integer that the JSON /
  // JS runtime can represent exactly: values above Number.MAX_SAFE_INTEGER
  // (2^53 - 1) cannot round-trip without losing a cent.
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER, {
    message:
      'amount must not exceed Number.MAX_SAFE_INTEGER (9007199254740991) to guarantee exact cent arithmetic',
  })
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  // Client-generated idempotency key. May also be supplied via the
  // Idempotency-Key header. Required — see README for the contract.
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotencyKey?: string;
}
