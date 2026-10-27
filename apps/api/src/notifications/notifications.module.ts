import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser, Roles, StaffGuard } from '../common/auth';
import { Clock } from '../common/clock';
import { CampaignDto, DeviceDto, ReachDto, ReadDto } from './notifications.dto';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { RemindersService } from './reminders.service';
import { NotificationsScheduler } from './scheduler.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('v1')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('devices')
  @HttpCode(204)
  register(@CurrentUser() user: AuthUser, @Body() dto: DeviceDto) {
    return this.notifications.registerDevice(user.id, dto);
  }

  /** On sign-out, so the next person on the phone doesn't get this member's notifications. */
  @Delete('devices/:token')
  @HttpCode(204)
  forget(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    return this.notifications.forgetDevice(user.id, token);
  }

  @Get('notifications')
  bell(@CurrentUser() user: AuthUser) {
    return this.notifications.bell(user.id);
  }

  @Get('notifications/unread')
  unread(@CurrentUser() user: AuthUser) {
    return this.notifications.unread(user.id);
  }

  @Post('notifications/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthUser, @Body() dto: ReadDto) {
    return this.notifications.markRead(user.id, dto.ids);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/notifications')
@UseGuards(AuthGuard, StaffGuard)
@Roles('content')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list() {
    return this.notifications.campaigns();
  }

  @Post('reach')
  @HttpCode(200)
  reach(@Body() dto: ReachDto) {
    return this.notifications.reach(dto.audience);
  }

  @Post()
  send(@CurrentUser() me: AuthUser, @Body() dto: CampaignDto) {
    return this.notifications.send(me.id, dto);
  }

  /** Calls back a scheduled message before it goes. */
  @Delete(':id')
  @HttpCode(204)
  async cancel(@CurrentUser() me: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.notifications.cancel(me.id, id);
  }
}

@Module({
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [NotificationsService, PushService, RemindersService, NotificationsScheduler, Clock],
  exports: [NotificationsScheduler, Clock],
})
export class NotificationsModule {}
