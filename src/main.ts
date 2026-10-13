import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { JwtSecretValidator } from './auth/jwt-secret.validator';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Fail fast if JWT_SECRET is missing, too short, or a known placeholder —
  // never silently fall back to a guessable key.
  app.get(JwtSecretValidator, { strict: false }).validateOrThrow();

  // Standard security headers (HSTS, no-sniff, frame-deny, CSP...).
  app.use(helmet());

  // Let the platform's router (Railway/Render/Fly) forward the real client IP
  // and terminate TLS in front of us.
  const expressApp = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
  };
  expressApp.set?.('trust proxy', 1);
  app.enableCors({ origin: true });

  // Finish in-flight requests before the process exits, so a redeploy never
  // cuts a transfer off midway through its money movement.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  console.log(`Application running on port ${port}`);
}
void bootstrap();
