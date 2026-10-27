import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;
}

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class AdminReviewQuery {
  @IsOptional()
  @IsIn(['visible', 'hidden'])
  status?: 'visible' | 'hidden';
}

export class ReviewStatusDto {
  @IsIn(['visible', 'hidden'])
  status: 'visible' | 'hidden';
}

export class ReplyDto {
  /** Shown under the review as "Reply from Embodha". An empty reply removes it. */
  @IsString()
  @MaxLength(2000)
  reply: string;
}
