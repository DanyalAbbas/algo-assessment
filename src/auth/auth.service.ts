import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

// Refresh tokens are opaque random strings (not JWTs) so they can be
// revoked server-side before they expire. Only their SHA-256 hash is stored.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

function refreshTtlMs(): number {
  const raw = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';
  const match = /^(\d+)([smhd])$/.exec(raw);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2];
  const mult =
    unit === 's'
      ? 1000
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : 86_400_000;
  return n * mult;
}

// A fixed bcrypt hash (of a value nobody knows) used only to equalize the
// timing cost of the "user not found" branch against the real comparison,
// preventing timing-based user enumeration.
const DUMMY_HASH =
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        name: dto.name,
      },
    });
    // Every user gets a default account so they can receive money immediately.
    await this.prisma.account.create({
      data: { userId: user.id, name: 'Main' },
    });
    return this.issueSession(user.id, user.email, user.name);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user) {
      // Perform a dummy bcrypt comparison so the unknown-user path costs the
      // same as the known-user path, preventing timing-based user enumeration.
      await bcrypt.compare(dto.password, DUMMY_HASH);
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.issueSession(user.id, user.email, user.name);
  }

  // Exchange a valid refresh token for a new access + refresh token pair.
  // The old refresh token is revoked (rotation). If a revoked token is
  // presented again — or if two concurrent requests race to use the same
  // token — we treat it as theft and revoke every token for the user.
  async refresh(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.revokedAt) {
      throw await this.handleReuse(stored.userId);
    }
    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const next = generateRefreshToken();
    const nextHash = hashToken(next);
    const nextExpiresAt = new Date(Date.now() + refreshTtlMs());

    // Compare-and-swap rotation. The UPDATE is conditional on the token still
    // being unrevoked, so two concurrent refreshes with the same token cannot
    // both succeed: exactly one matches a row and rotates; the loser sees
    // count === 0 and is treated as reuse. This closes the check-then-act
    // window that a plain read-then-update would leave.
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date(), lastUsedAt: new Date() },
      });
      if (claimed.count === 0) {
        return null;
      }
      const replacement = await tx.refreshToken.create({
        data: {
          tokenHash: nextHash,
          userId: stored.userId,
          expiresAt: nextExpiresAt,
        },
        select: { id: true },
      });
      // Record the rotation chain for audit.
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { replacedById: replacement.id },
      });
      return replacement.id;
    });

    if (rotated === null) {
      // Lost the race — another request already rotated this token.
      throw await this.handleReuse(stored.userId);
    }

    const accessToken = this.signAccess(stored.userId, stored.user.email);
    return {
      accessToken,
      refreshToken: next,
      refreshTokenExpiresAt: nextExpiresAt.toISOString(),
      user: stored.user,
    };
  }

  // Reuse of a revoked (or concurrently-rotated) refresh token means the token
  // may be compromised. Revoke every session for that user and reject.
  private async handleReuse(userId: string): Promise<UnauthorizedException> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return new UnauthorizedException(
      'Refresh token reuse detected — all sessions revoked',
    );
  }

  // Revoke a single refresh token (logout on one device).
  async logout(refreshToken: string) {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  // Revoke every refresh token for the user (logout everywhere).
  async logoutAll(userId: string) {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true, revoked: result.count };
  }

  private signAccess(userId: string, email: string): string {
    return this.jwt.sign({ sub: userId, email });
  }

  private async issueSession(userId: string, email: string, name: string) {
    const accessToken = this.signAccess(userId, email);
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + refreshTtlMs());
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        userId,
        expiresAt,
      },
    });
    return {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt: expiresAt.toISOString(),
      user: { id: userId, email, name },
    };
  }
}
