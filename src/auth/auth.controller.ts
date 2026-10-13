import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MinLength } from 'class-validator';

// Strict defaults for credential endpoints; overridable so the test suite can
// raise them without weakening production.
const AUTH_LOGIN_LIMIT = () => Number(process.env.AUTH_LOGIN_RATE_LIMIT || 60);
const AUTH_REFRESH_LIMIT = () =>
  Number(process.env.AUTH_REFRESH_RATE_LIMIT || 120);
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

class RefreshDto {
  @IsString()
  @MinLength(10)
  refreshToken: string;
}

class LogoutDto {
  @IsString()
  @MinLength(10)
  refreshToken: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Tight per-route limits: credential stuffing / brute-force protection.
  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT(), ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Throttle({ default: { limit: AUTH_LOGIN_LIMIT(), ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  // Exchange a refresh token for a new access + refresh pair (rotation).
  @Throttle({ default: { limit: AUTH_REFRESH_LIMIT(), ttl: 60_000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  // Revoke one refresh token (logout this device).
  @Throttle({ default: { limit: AUTH_REFRESH_LIMIT(), ttl: 60_000 } })
  @Post('logout')
  logout(@Body() dto: LogoutDto) {
    return this.auth.logout(dto.refreshToken);
  }

  // Revoke every refresh token for the authenticated user (logout everywhere).
  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  logoutAll(@CurrentUser() user: { id: string }) {
    return this.auth.logoutAll(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: { id: string; email: string }) {
    return user;
  }
}
