import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { QUALITIES, type Quality } from './files';

/** The phone asking: the random ID its download manager made, and what kind of phone it is. */
export class DevicePartDto {
  @Matches(/^[A-Za-z0-9-]{8,64}$/, { message: 'deviceId should be the random ID the app made.' })
  deviceId: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';

  /** The phone's model ("Pixel 8"), so the member can tell their phones apart in the list. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class StartDownloadDto extends DevicePartDto {
  @IsUUID()
  chapterId: string;

  @IsIn(QUALITIES)
  quality: Quality;
}

export class CheckDownloadsDto extends DevicePartDto {
  /** Every chapter on the phone, finished or still downloading. */
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  chapterIds: string[];
}
