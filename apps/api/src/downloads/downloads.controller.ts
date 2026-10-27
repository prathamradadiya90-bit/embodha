import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { fail } from '../common/errors';
import { CheckDownloadsDto, StartDownloadDto } from './downloads.dto';
import { DownloadsService } from './downloads.service';

const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/;

@ApiTags('downloads')
@ApiBearerAuth()
@Controller('v1/downloads')
@UseGuards(AuthGuard)
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  /**
   * Before saving a chapter: 200 with a link to the file (good for a few hours) and how long it plays offline;
   * 402 when the course isn't the member's; 409 `device_limit` when the account's downloads are on as many phones as
   * allowed, or `not_downloadable` when the chapter has no file to save yet.
   */
  @Post()
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Body() dto: StartDownloadDto) {
    return this.downloads.start(user.id, dto);
  }

  /** The phone's check-in, with every chapter it holds. Renews them, and says which to delete and why. */
  @Post('check')
  @HttpCode(200)
  check(@CurrentUser() user: AuthUser, @Body() dto: CheckDownloadsDto) {
    return this.downloads.check(user.id, dto);
  }

  /** The phones with downloads on them. Pass this phone's deviceId to have it marked. */
  @Get('devices')
  devices(@CurrentUser() user: AuthUser, @Query('deviceId') deviceId?: string) {
    return this.downloads.devices(user.id, deviceId && DEVICE_ID.test(deviceId) ? deviceId : undefined);
  }

  /** Frees a phone's place. That phone deletes its downloads when it next checks in. */
  @Delete('devices/:id')
  @HttpCode(204)
  async removeDevice(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    if (!DEVICE_ID.test(id)) throw fail(400, 'invalid_id', 'That ID is not valid.');
    await this.downloads.removeDevice(user.id, id);
  }
}
