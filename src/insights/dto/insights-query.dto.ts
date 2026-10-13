import { IsOptional, Matches } from 'class-validator';

// month is optional; when present it must be a real YYYY-MM calendar month.
// Without this, a malformed value reaches monthBounds() and produces an
// Invalid Date that surfaces as a 500 instead of a 400.
export class InsightsQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be formatted YYYY-MM (e.g. 2026-10)',
  })
  month?: string;
}
