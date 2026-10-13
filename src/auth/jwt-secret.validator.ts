import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Thresholds for JWT_SECRET. A real secret must be high-entropy; we reject
// anything short, still set to a well-known placeholder, or the previous
// hardcoded fallback. This runs once at startup so the process fails fast
// rather than silently signing/verifying tokens with a guessable key.
const MIN_SECRET_LENGTH = 32;
const FORBIDDEN_SECRETS = new Set([
  'dev-secret',
  'change-me-in-production-use-long-random-string',
  'secret',
  'changeme',
]);

@Injectable()
export class JwtSecretValidator {
  constructor(private readonly config: ConfigService) {}

  validateOrThrow() {
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret || secret.trim().length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET must be set to a random string of at least ${MIN_SECRET_LENGTH} characters. ` +
          `Generate one with: openssl rand -base64 48`,
      );
    }
    if (FORBIDDEN_SECRETS.has(secret.trim().toLowerCase())) {
      throw new Error(
        'JWT_SECRET is set to a well-known placeholder value. ' +
          'Generate a unique secret with: openssl rand -base64 48',
      );
    }
    return secret;
  }
}
