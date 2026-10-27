import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { uuidParam } from '../common/errors';
import { BreathingSessionDto, HeartbeatsDto } from './practice.dto';
import { PracticeService } from './practice.service';

@ApiTags('practice')
@Controller('v1')
export class PracticeController {
  constructor(private readonly practice: PracticeService) {}

  /** Public. The app also bundles these, so breathing works offline. */
  @Get('breathing/patterns')
  patterns() {
    return this.practice.patterns();
  }

  /** Logs a finished breathing session and returns the updated streak. */
  @Post('breathing/sessions')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  logBreathing(@CurrentUser() user: AuthUser, @Body() dto: BreathingSessionDto) {
    return this.practice.logBreathing(user.id, dto);
  }

  @Get('me/stats')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  stats(@CurrentUser() user: AuthUser) {
    return this.practice.stats(user.id);
  }

  /** The player sends one every 30 seconds; heartbeats recorded offline arrive later in a batch of up to 50. */
  @Post('playback/heartbeats')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  heartbeats(@CurrentUser() user: AuthUser, @Body() dto: HeartbeatsDto) {
    return this.practice.heartbeats(user.id, dto.events);
  }

  @Post('chapters/:id/complete')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  complete(@CurrentUser() user: AuthUser, @Param('id', uuidParam) id: string) {
    return this.practice.complete(user.id, id);
  }
}
