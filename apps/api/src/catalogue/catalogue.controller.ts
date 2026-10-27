import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, OptionalAuthGuard } from '../common/auth';
import { fail, uuidParam } from '../common/errors';
import { CatalogueService } from './catalogue.service';
import { PlaybackService } from './playback.service';
import { Viewer, resolveCurrency } from './price';

const viewerOf = (user: AuthUser | undefined, currency?: string): Viewer => ({
  userId: user?.id ?? null,
  currency: resolveCurrency(currency, user?.country),
});

@ApiTags('catalogue')
@Controller('v1')
@UseGuards(OptionalAuthGuard)
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly playback: PlaybackService,
  ) {}

  @Get('categories')
  categories() {
    return this.catalogue.categories();
  }

  /** The home screen in one call. Pass the device's local date (YYYY-MM-DD) so "today" matches the member's day. */
  @Get('home')
  home(@Query('date') date?: string, @Query('currency') currency?: string, @CurrentUser() user?: AuthUser) {
    const today = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    return this.catalogue.home(viewerOf(user, currency), today);
  }

  @Get('library')
  library(@Query('currency') currency?: string, @CurrentUser() user?: AuthUser) {
    if (!user) throw fail(401, 'unauthenticated', 'Sign in to see your library.');
    return this.catalogue.library(user.id, viewerOf(user, currency));
  }

  /** Courses (by title, description, instructor or topic) and topics. Two characters or more. */
  @Get('search')
  search(@Query('q') q?: string, @Query('currency') currency?: string, @CurrentUser() user?: AuthUser) {
    return this.catalogue.search(String(q ?? ''), viewerOf(user, currency));
  }

  /** Pass ?currency=INR or USD to override what the member's country implies. */
  @Get('topics/:slug')
  topic(@Param('slug') slug: string, @Query('currency') currency?: string, @CurrentUser() user?: AuthUser) {
    return this.catalogue.topic(slug, viewerOf(user, currency));
  }

  @Get('courses/:slug')
  course(@Param('slug') slug: string, @Query('currency') currency?: string, @CurrentUser() user?: AuthUser) {
    return this.catalogue.course(slug, viewerOf(user, currency));
  }

  /** 200 with a signed URL; 402 with prices when locked; 409 while the upload is still processing. */
  @Get('chapters/:id/playback')
  play(@Param('id', uuidParam) id: string, @Query('currency') currency?: string, @CurrentUser() user?: AuthUser) {
    return this.playback.forChapter(id, viewerOf(user, currency));
  }
}
