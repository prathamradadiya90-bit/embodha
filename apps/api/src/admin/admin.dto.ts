import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { COURSE_STATUSES } from '../db/schema';

const tidyEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class UserListQuery {
  /** Matches email or name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class CreateUserDto {
  @Transform(tidyEmail)
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;
}

export class UserStatusDto {
  @IsIn(['active', 'suspended'])
  status: 'active' | 'suspended';
}

export class GrantDto {
  @IsUUID()
  courseId: string;
}

export class CreateCategoryDto {
  @IsString()
  @Length(2, 60)
  name: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  /** Whether members see it in the app. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateTopicDto {
  @IsUUID()
  categoryId: string;

  @IsString()
  @Length(2, 60)
  name: string;
}

export class UpdateTopicDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CourseListQuery {
  @IsOptional()
  @IsIn(COURSE_STATUSES)
  status?: (typeof COURSE_STATUSES)[number];
}

export class ReviewCourseDto {
  @IsIn(['publish', 'return'])
  decision: 'publish' | 'return';

  /** Required when returning a course: the instructor sees it in the studio. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comments?: string;
}

export class CreateInstructorDto {
  @Transform(tidyEmail)
  @IsEmail()
  email: string;

  @IsString()
  @Length(2, 80)
  displayName: string;

  /** Basis points: 6000 is 60%. Defaults to the default_revenue_share_bps setting. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  percentBps?: number;
}

export class InstructorStatusDto {
  @IsIn(['approved', 'suspended'])
  status: 'approved' | 'suspended';
}

export class ShareDto {
  @IsInt()
  @Min(0)
  @Max(10000)
  percentBps: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class DailyQuoteDto {
  @IsString()
  @Length(2, 280)
  text: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  author?: string;
}

/** The caption (and, for a photo, the credit) sent with a photo or video of the day. */
export class DailyMediaDto {
  @IsOptional()
  @IsString()
  @MaxLength(140)
  caption?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  credit?: string;
}

export class DailyQuery {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must look like 2026-10-21' })
  from?: string;
}

export class ReportQuery {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must look like 2026-10' })
  month?: string;
}

export class ReviewChangesDto {
  @IsIn(['approve', 'return'])
  decision: 'approve' | 'return';

  /** Needed to send changes back: what the instructor should do. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comments?: string;
}
