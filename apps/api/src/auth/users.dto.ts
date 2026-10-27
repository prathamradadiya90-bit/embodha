import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { GENDERS } from '../db/schema';
import { STATE_CODES } from '../money/gst';

export const GOALS = ['sleep', 'stress', 'fitness', 'flexibility', 'focus', 'strength', 'healing'] as const;

/** The details asked for after sign-up. Everything is optional so the app can save one screen at a time. */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  /** ISO country code. Sets the currency shown and whether GST applies. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsISO31661Alpha2()
  country?: string;

  /**
   * In India, the state or union territory by its GST code ('29' is Karnataka). It decides whether a website
   * invoice carries CGST and SGST or IGST. Ignored, and cleared, for members anywhere else. Null clears it.
   */
  @IsOptional()
  @IsIn(STATE_CODES, { message: 'state must be a GST state code, like 29 for Karnataka' })
  state?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1900)
  birthYear?: number;

  @IsOptional()
  @IsIn(GENDERS)
  gender?: (typeof GENDERS)[number];

  /** IANA time zone, e.g. Asia/Kolkata. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(GOALS.length)
  @IsIn(GOALS, { each: true })
  goals?: string[];

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'reminderTime must look like 07:30' })
  reminderTime?: string;

  @IsOptional()
  @IsBoolean()
  breathOnLaunch?: boolean;

  @IsOptional()
  @IsIn(['en', 'hi'])
  language?: string;
}
