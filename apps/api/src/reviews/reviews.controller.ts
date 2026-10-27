import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser, OptionalAuthGuard, Roles, StaffGuard } from '../common/auth';
import { uuidParam } from '../common/errors';
import { AdminReviewQuery, PageQuery, ReplyDto, ReviewDto, ReviewStatusDto } from './reviews.dto';
import { ReviewsService } from './reviews.service';

@ApiTags('reviews')
@Controller('v1/courses/:slug/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @UseGuards(OptionalAuthGuard)
  list(@Param('slug') slug: string, @Query() query: PageQuery, @CurrentUser() user?: AuthUser) {
    return this.reviews.list(slug, user?.id ?? null, query.page);
  }

  @Put('mine')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  write(@Param('slug') slug: string, @CurrentUser() user: AuthUser, @Body() dto: ReviewDto) {
    return this.reviews.write(slug, user.id, dto);
  }

  @Delete('mine')
  @HttpCode(204)
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  remove(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.reviews.remove(slug, user.id);
  }
}

/** Hide, reply to and delete reviews. Nobody can write a review on a member's behalf. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin/reviews')
@UseGuards(AuthGuard, StaffGuard)
@Roles('support', 'content')
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Query() query: AdminReviewQuery) {
    return this.reviews.adminList(query.status);
  }

  @Patch(':id')
  status(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: ReviewStatusDto) {
    return this.reviews.setStatus(me.id, id, dto.status);
  }

  @Put(':id/reply')
  reply(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: ReplyDto) {
    return this.reviews.reply(me.id, id, dto.reply);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    return this.reviews.adminDelete(me.id, id);
  }
}
