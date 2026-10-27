import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { RefreshDto, StartEmailDto, VerifyEmailDto } from './auth.dto';
import { AuthService, SignInContext } from './auth.service';

const contextOf = (req: Request, deviceId?: string): SignInContext => ({
  ip: req.ip,
  deviceId,
  userAgent: req.headers['user-agent']?.slice(0, 200),
});

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Emails a six-digit code and a one-tap link. */
  @Post('email/start')
  @HttpCode(200)
  start(@Body() dto: StartEmailDto, @Req() req: Request) {
    return this.auth.startEmail(dto.email, contextOf(req, dto.deviceId));
  }

  /** Exchanges the code (or the link token) for tokens. Creates the account on first sign-in. */
  @Post('email/verify')
  @HttpCode(200)
  verify(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    const ctx = contextOf(req, dto.deviceId);
    return dto.token ? this.auth.verifyLink(dto.token, ctx) : this.auth.verifyCode(dto.email!, dto.code!, ctx);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  async logout(@CurrentUser() user: AuthUser) {
    await this.auth.logout(user.sessionId);
  }
}
