import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { tmpdir } from 'node:os';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser, Roles, StaffGuard } from '../common/auth';
import { fail, uuidParam } from '../common/errors';
import {
  CourseListQuery,
  CreateCategoryDto,
  CreateInstructorDto,
  CreateTopicDto,
  CreateUserDto,
  DailyQuery,
  DailyMediaDto,
  DailyQuoteDto,
  GrantDto,
  InstructorStatusDto,
  ReportQuery,
  ReviewChangesDto,
  ReviewCourseDto,
  ShareDto,
  UpdateCategoryDto,
  UpdateTopicDto,
  UserListQuery,
  UserStatusDto,
} from './admin.dto';
import { AdminService } from './admin.service';

function checkDate(date: string) {
  // A round trip catches dates JavaScript would quietly roll over, like 31 February.
  const real = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
  if (!real) throw fail(400, 'invalid_date', 'Use a real date like 2026-10-21.');
  return date;
}

/**
 * Staff only. Roles: content runs the catalogue, course review and instructor accounts; finance sets percentages
 * and reads reports; support looks after members. Super admins can do everything. Every change is audit-logged.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(AuthGuard, StaffGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('courses')
  @Roles('content', 'support')
  courses(@Query() query: CourseListQuery) {
    return this.admin.courses(query.status);
  }

  /** Publish a course waiting for review, or send it back to the instructor with comments. */
  @Post('courses/:id/review')
  @HttpCode(200)
  @Roles('content')
  review(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: ReviewCourseDto) {
    return this.admin.reviewCourse(me.id, id, dto);
  }

  /** Changes an instructor made to a live course, as before-and-after lines. */
  @Get('courses/:id/changes')
  @Roles('content')
  changes(@Param('id', uuidParam) id: string) {
    return this.admin.courseChanges(id);
  }

  @Post('courses/:id/changes')
  @HttpCode(200)
  @Roles('content')
  decideChanges(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: ReviewChangesDto) {
    return this.admin.decideChanges(me.id, id, dto);
  }

  @Post('courses/:id/archive')
  @HttpCode(200)
  @Roles('content')
  archive(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    return this.admin.archiveCourse(me.id, id);
  }

  @Post('courses/:id/free')
  @HttpCode(200)
  @Roles('content')
  makeFree(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    return this.admin.setFreeCourse(me.id, id);
  }

  @Get('instructors')
  @Roles('content', 'finance')
  instructors() {
    return this.admin.instructors();
  }

  @Post('instructors')
  @Roles('content')
  addInstructor(@CurrentUser() me: AuthUser, @Body() dto: CreateInstructorDto) {
    return this.admin.createInstructor(me.id, dto);
  }

  @Patch('instructors/:id')
  @Roles('content')
  instructorStatus(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: InstructorStatusDto) {
    return this.admin.setInstructorStatus(me.id, id, dto.status);
  }

  @Post('instructors/:id/share')
  @HttpCode(200)
  @Roles('finance')
  share(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: ShareDto) {
    return this.admin.setShare(me.id, id, dto);
  }

  @Get('users')
  @Roles('support')
  users(@Query() query: UserListQuery) {
    return this.admin.users(query.q, query.page);
  }

  @Post('users')
  @Roles('support')
  addUser(@CurrentUser() me: AuthUser, @Body() dto: CreateUserDto) {
    return this.admin.createUser(me.id, dto);
  }

  @Get('users/:id')
  @Roles('support')
  user(@Param('id', uuidParam) id: string) {
    return this.admin.user(id);
  }

  @Patch('users/:id')
  @Roles('support')
  userStatus(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: UserStatusDto) {
    return this.admin.setUserStatus(me.id, id, dto.status);
  }

  /** Same as the member deleting it themselves: signed out everywhere, erased after 30 days. */
  @Delete('users/:id')
  @HttpCode(202)
  @Roles('support')
  deleteUser(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    return this.admin.deleteUser(me.id, id);
  }

  @Post('users/:id/grants')
  @Roles('support')
  grant(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: GrantDto) {
    return this.admin.grant(me.id, id, dto.courseId);
  }

  @Delete('users/:id/grants/:courseId')
  @HttpCode(204)
  @Roles('support')
  revoke(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Param('courseId', uuidParam) courseId: string) {
    return this.admin.revoke(me.id, id, courseId);
  }

  @Get('catalogue')
  @Roles('content')
  catalogue() {
    return this.admin.catalogue();
  }

  @Post('categories')
  @Roles('content')
  addCategory(@CurrentUser() me: AuthUser, @Body() dto: CreateCategoryDto) {
    return this.admin.createCategory(me.id, dto);
  }

  @Patch('categories/:id')
  @Roles('content')
  updateCategory(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: UpdateCategoryDto) {
    return this.admin.updateCategory(me.id, id, dto);
  }

  @Post('topics')
  @Roles('content')
  addTopic(@CurrentUser() me: AuthUser, @Body() dto: CreateTopicDto) {
    return this.admin.createTopic(me.id, dto);
  }

  @Patch('topics/:id')
  @Roles('content')
  updateTopic(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: UpdateTopicDto) {
    return this.admin.updateTopic(me.id, id, dto);
  }

  @Get('daily')
  @Roles('content')
  daily(@Query() query: DailyQuery) {
    return this.admin.daily(query.from);
  }

  @Put('daily/:date')
  @Roles('content')
  setDaily(@CurrentUser() me: AuthUser, @Param('date') date: string, @Body() dto: DailyQuoteDto) {
    return this.admin.setDaily(me.id, checkDate(date), dto);
  }

  @Delete('daily/:date')
  @HttpCode(204)
  @Roles('content')
  removeDaily(@CurrentUser() me: AuthUser, @Param('date') date: string) {
    return this.admin.removeDaily(me.id, checkDate(date));
  }

  /** The photo of the day: a JPEG, PNG or WebP up to 15 MB, with an optional caption and credit. */
  @Post('daily/:date/image')
  @Roles('content')
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  dailyImage(@CurrentUser() me: AuthUser, @Param('date') date: string, @Body() dto: DailyMediaDto, @UploadedFile() file?: Express.Multer.File) {
    return this.admin.setDailyImage(me.id, checkDate(date), dto, file);
  }

  /** The video of the day: answers with a tus ticket, and the browser uploads straight to Bunny. */
  @Post('daily/:date/clip')
  @Roles('content')
  dailyClip(@CurrentUser() me: AuthUser, @Param('date') date: string, @Body() dto: DailyMediaDto) {
    return this.admin.startDailyClip(me.id, checkDate(date), dto);
  }

  @Delete('daily/:date/:type')
  @HttpCode(204)
  @Roles('content')
  removeDailyItem(@CurrentUser() me: AuthUser, @Param('date') date: string, @Param('type') type: string) {
    if (type !== 'quote' && type !== 'image' && type !== 'clip') throw fail(400, 'invalid_type', 'The type is quote, image or clip.');
    return this.admin.removeDaily(me.id, checkDate(date), type);
  }

  @Get('reports/watch')
  @Roles('finance', 'content')
  watchReport(@Query() query: ReportQuery) {
    return this.admin.watchReport(query.month);
  }
}
