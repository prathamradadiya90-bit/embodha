import { Inject, Injectable } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { and, asc, eq } from 'drizzle-orm';
import { fail } from '../common/errors';
import { notesKey, seal, unseal } from '../common/sealed';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Db, InjectDb } from '../db/db.module';
import { chapters, notes } from '../db/schema';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class NoteDto {
  @Transform(trim)
  @IsString()
  @Length(1, 5000)
  body: string;

  /** Where in the chapter the note belongs, in seconds. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  timestampS?: number;
}

export class UpdateNoteDto {
  @Transform(trim)
  @IsString()
  @Length(1, 5000)
  body: string;
}

/** Private notes: only the member can read them. Stored encrypted, so a database leak doesn't leak them. */
@Injectable()
export class NotesService {
  private readonly key: Buffer;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ENV) env: Env,
  ) {
    this.key = notesKey(env);
  }

  async list(userId: string, chapterId: string) {
    await this.chapter(chapterId);
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.chapterId, chapterId)))
      .orderBy(asc(notes.timestampS), asc(notes.createdAt));
    return rows.map((row) => this.view(row));
  }

  /** Every note a member has written, readable, for their data download. */
  async everything(userId: string) {
    const rows = await this.db.select().from(notes).where(eq(notes.userId, userId)).orderBy(asc(notes.createdAt));
    return rows.map((row) => this.view(row));
  }

  async add(userId: string, chapterId: string, dto: NoteDto) {
    await this.chapter(chapterId);
    const [row] = await this.db
      .insert(notes)
      .values({ userId, chapterId, timestampS: dto.timestampS ?? null, bodyEnc: seal(dto.body, this.key) })
      .returning();
    return this.view(row);
  }

  async update(userId: string, noteId: string, dto: UpdateNoteDto) {
    const [row] = await this.db
      .update(notes)
      .set({ bodyEnc: seal(dto.body, this.key) })
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
      .returning();
    if (!row) throw fail(404, 'not_found', 'No such note.');
    return this.view(row);
  }

  async remove(userId: string, noteId: string) {
    const removed = await this.db.delete(notes).where(and(eq(notes.id, noteId), eq(notes.userId, userId))).returning({ id: notes.id });
    if (!removed.length) throw fail(404, 'not_found', 'No such note.');
  }

  private view(row: typeof notes.$inferSelect) {
    return { id: row.id, chapterId: row.chapterId, timestampS: row.timestampS, body: unseal(row.bodyEnc, this.key), createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  private async chapter(chapterId: string) {
    const [row] = await this.db.select({ id: chapters.id }).from(chapters).where(eq(chapters.id, chapterId)).limit(1);
    if (!row) throw fail(404, 'not_found', 'There is no chapter at that address.');
  }
}
