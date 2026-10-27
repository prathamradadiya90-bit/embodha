import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';

export class BreathingSessionDto {
  @IsOptional()
  @IsUUID()
  patternId?: string;

  @IsInt()
  @Min(5)
  @Max(3600)
  seconds: number;
}

export class HeartbeatEventDto {
  @IsUUID()
  chapterId: string;

  /** Where the player is now, in seconds from the start. */
  @IsInt()
  @Min(0)
  @Max(86_400)
  positionS: number;

  /** Seconds actually played since the previous heartbeat. Seeking doesn't count. */
  @IsInt()
  @Min(0)
  @Max(120)
  seconds: number;

  /** When the device recorded it. Offline heartbeats arrive later with their original time. */
  @IsISO8601()
  at: string;
}

export class HeartbeatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HeartbeatEventDto)
  events: HeartbeatEventDto[];
}
