import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtSecretValidator } from './jwt-secret.validator';

@Module({
  imports: [
    PassportModule,
    // Load the secret through ConfigService (not process.env at import time)
    // so there is a single source of truth shared with JwtStrategy.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // Short-lived access token; the refresh token (opaque, rotatable,
          // revocable server-side) is the long-lived credential. See DECISIONS.md.
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') || '15m') as any,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtSecretValidator],
  exports: [JwtModule, JwtSecretValidator],
})
export class AuthModule {}
