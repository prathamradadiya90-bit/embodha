import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles, StaffGuard } from '../common/auth';
import { LaunchService } from './launch.service';

export class SignoffDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** The launch checklist. Every staff role can read it; the person who decides on launch signs off what only a person can. */
@ApiTags('admin')
@Controller('v1/admin/launch')
@UseGuards(AuthGuard, StaffGuard)
export class LaunchController {
  constructor(private readonly launch: LaunchService) {}

  /** `fresh=1` looks at the website and DNS again instead of using what was found in the last two minutes. */
  @Get()
  checklist(@Query('fresh') fresh?: string) {
    return this.launch.checklist(fresh === '1' || fresh === 'true');
  }

  @Post('signoffs/:key')
  @HttpCode(200)
  @Roles('super_admin')
  signOff(@CurrentUser() me: AuthUser, @Param('key') key: string, @Body() dto: SignoffDto) {
    return this.launch.signOff(me.id, key, dto.note ?? null);
  }

  @Delete('signoffs/:key')
  @Roles('super_admin')
  withdraw(@CurrentUser() me: AuthUser, @Param('key') key: string) {
    return this.launch.withdraw(me.id, key);
  }

  @Post('apple-test')
  @HttpCode(200)
  @Roles('finance')
  appleTest(@CurrentUser() me: AuthUser) {
    return this.launch.askAppleForTest(me.id);
  }

  /** Reads finished videos without a downloadable copy from Bunny again. */
  @Post('video-downloads')
  @HttpCode(200)
  @Roles('content')
  videoDownloads(@CurrentUser() me: AuthUser) {
    return this.launch.lookForVideoDownloads(me.id);
  }
}
