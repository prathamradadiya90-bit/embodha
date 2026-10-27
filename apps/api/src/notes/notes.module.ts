import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth';
import { uuidParam } from '../common/errors';
import { NoteDto, NotesService, UpdateNoteDto } from './notes.service';

@ApiTags('notes')
@ApiBearerAuth()
@Controller('v1')
@UseGuards(AuthGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get('chapters/:id/notes')
  list(@CurrentUser() user: AuthUser, @Param('id', uuidParam) id: string) {
    return this.notes.list(user.id, id);
  }

  @Post('chapters/:id/notes')
  add(@CurrentUser() user: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: NoteDto) {
    return this.notes.add(user.id, id, dto);
  }

  @Patch('notes/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: UpdateNoteDto) {
    return this.notes.update(user.id, id, dto);
  }

  @Delete('notes/:id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', uuidParam) id: string) {
    return this.notes.remove(user.id, id);
  }
}

@Module({ controllers: [NotesController], providers: [NotesService], exports: [NotesService] })
export class NotesModule {}
