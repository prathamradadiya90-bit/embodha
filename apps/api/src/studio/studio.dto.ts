import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { LEVELS } from '../db/schema';

export class CreateCourseDto {
  @IsUUID()
  topicId: string;

  @IsString()
  @Length(3, 120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsIn(LEVELS)
  level?: (typeof LEVELS)[number];

  @IsOptional()
  @IsIn(['en', 'hi'])
  language?: string;
}

export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @Length(3, 120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsIn(LEVELS)
  level?: (typeof LEVELS)[number];

  @IsOptional()
  @IsIn(['en', 'hi'])
  language?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  equipment?: string[];

  /** Who should sit this one out, shown on the course page. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cautions?: string;

  /** One of admin's course price points. Admin approves it with the course. */
  @IsOptional()
  @IsUUID()
  pricePointId?: string;
}

export class CreateChapterDto {
  @IsString()
  @Length(2, 120)
  title: string;

  @IsIn(['video', 'audio'])
  type: 'video' | 'audio';

  /** A free preview plays for everyone, guests included. */
  @IsOptional()
  @IsBoolean()
  isPreview?: boolean;
}

export class UpdateChapterDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isPreview?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

export class PlanDto {
  @IsBoolean()
  enabled: boolean;

  /** One of admin's monthly price points. Needed the first time the plan is switched on. */
  @IsOptional()
  @IsUUID()
  pricePointId?: string;
}

export class ChapterOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids: string[];
}
