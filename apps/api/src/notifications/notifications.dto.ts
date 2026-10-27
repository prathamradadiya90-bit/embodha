import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
import { GENDERS } from '../db/schema';

export class DeviceDto {
  /** The Expo push token, e.g. ExponentPushToken[xxxx]. */
  @IsString()
  @Matches(/^(Exponent|Expo)PushToken\[[\w-]+\]$/, { message: 'token must be an Expo push token' })
  token: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';

  @IsOptional()
  @IsString()
  @Length(1, 20)
  appVersion?: string;
}

export class ReadDto {
  /** Leave out to mark everything read. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids?: string[];
}

/** Who a campaign goes to. Empty means every active member. Members who haven't given an age or gender are left out of filters on them. */
export class AudienceDto {
  @IsOptional()
  @IsArray()
  @IsIn(GENDERS, { each: true })
  genders?: (typeof GENDERS)[number][];

  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(120)
  ageMin?: number;

  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(120)
  ageMax?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(/^[A-Z]{2}$/, { each: true, message: 'countries must be two-letter codes like IN' })
  countries?: string[];
}

export class ReachDto {
  @ValidateNested()
  @Type(() => AudienceDto)
  audience: AudienceDto;
}

export class CampaignDto extends ReachDto {
  @IsString()
  @Length(2, 65)
  title: string;

  @IsString()
  @Length(2, 240)
  body: string;

  /** A screen in the app to open when tapped, e.g. /course/7-day-gentle-spine. */
  @IsOptional()
  @Matches(/^\/[\w\-/]*$/, { message: 'deepLink must be an app path like /course/some-course' })
  deepLink?: string;

  /** Send later instead of now: any time from a minute to 60 days ahead. */
  @IsOptional()
  @IsISO8601({ strict: true })
  sendAt?: string;
}
