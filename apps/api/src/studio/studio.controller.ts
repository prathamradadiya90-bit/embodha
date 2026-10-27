import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { tmpdir } from 'node:os';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentInstructor, CurrentUser, InstructorGuard, InstructorRef } from '../common/auth';
import { uuidParam } from '../common/errors';
import { ChapterOrderDto, CreateChapterDto, CreateCourseDto, PlanDto, UpdateChapterDto, UpdateCourseDto } from './studio.dto';
import { StudioService } from './studio.service';

@ApiTags('studio')
@ApiBearerAuth()
@Controller('v1/studio')
@UseGuards(AuthGuard, InstructorGuard)
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get('me')
  profile(@CurrentInstructor() me: InstructorRef) {
    return this.studio.profile(me.id);
  }

  @Get('options')
  options() {
    return this.studio.options();
  }

  @Put('plan')
  plan(@CurrentUser() user: AuthUser, @CurrentInstructor() me: InstructorRef, @Body() dto: PlanDto) {
    return this.studio.setPlan(me.id, dto, user.id);
  }

  @Get('courses')
  list(@CurrentInstructor() me: InstructorRef) {
    return this.studio.listCourses(me.id);
  }

  @Post('courses')
  create(@CurrentInstructor() me: InstructorRef, @Body() dto: CreateCourseDto) {
    return this.studio.createCourse(me.id, dto);
  }

  @Get('courses/:id')
  get(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string) {
    return this.studio.getCourse(me.id, id);
  }

  @Patch('courses/:id')
  update(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string, @Body() dto: UpdateCourseDto) {
    return this.studio.updateCourse(me.id, id, dto);
  }

  /** Draft → in review. Needs chapters with finished videos and a price (unless it's the free course). */
  @Post('courses/:id/submit')
  @HttpCode(200)
  submit(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string) {
    return this.studio.submit(me.id, id);
  }

  /** Changes to a live course: send them to admin, take them back to keep editing, or throw them away. */
  @Post('courses/:id/changes/submit')
  @HttpCode(200)
  submitChanges(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string) {
    return this.studio.submitChanges(me.id, id);
  }

  @Post('courses/:id/changes/withdraw')
  @HttpCode(200)
  withdrawChanges(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string) {
    return this.studio.withdrawChanges(me.id, id);
  }

  @Delete('courses/:id/changes')
  @HttpCode(204)
  discardChanges(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string) {
    return this.studio.discardChanges(me.id, id);
  }

  @Post('courses/:id/chapter-order')
  @HttpCode(200)
  reorder(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string, @Body() dto: ChapterOrderDto) {
    return this.studio.reorderChapters(me.id, id, dto.ids);
  }

  @Delete('chapters/:id')
  @HttpCode(204)
  deleteChapter(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string) {
    return this.studio.deleteChapter(me.id, id);
  }

  @Post('courses/:id/chapters')
  addChapter(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string, @Body() dto: CreateChapterDto) {
    return this.studio.addChapter(me.id, id, dto);
  }

  @Patch('chapters/:id')
  updateChapter(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string, @Body() dto: UpdateChapterDto) {
    return this.studio.updateChapter(me.id, id, dto);
  }

  /** Returns a signed TUS upload for tus-js-client. Upload straight to Bunny with it. */
  @Post('chapters/:id/upload')
  upload(@CurrentInstructor() me: InstructorRef, @CurrentUser() user: AuthUser, @Param('id', uuidParam) id: string) {
    return this.studio.startUpload(me.id, user.id, id);
  }

  /** Multipart upload, field "file", up to 500 MB. Answers 202; poll the media status until it's ready. */
  @Post('chapters/:id/audio')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: 500 * 1024 * 1024, files: 1 } }))
  audio(@CurrentInstructor() me: InstructorRef, @CurrentUser() user: AuthUser, @Param('id', uuidParam) id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.studio.startAudio(me.id, user.id, id, file);
  }

  @Get('media/:id')
  media(@CurrentInstructor() me: InstructorRef, @Param('id', uuidParam) id: string) {
    return this.studio.mediaStatus(me.id, id);
  }
}
