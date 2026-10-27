import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';

export class StartEmailDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** Lets us tie a session to a device, so "sign out of this phone" works later. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceId?: string;
}

/** Send either email + code, or the token from the one-tap link. */
export class VerifyEmailDto {
  @ValidateIf((dto: VerifyEmailDto) => !dto.token)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ValidateIf((dto: VerifyEmailDto) => !dto.token)
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code?: string;

  @ValidateIf((dto: VerifyEmailDto) => !dto.code)
  @IsString()
  @Length(20, 200)
  token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceId?: string;
}

export class RefreshDto {
  @IsString()
  @Length(40, 300)
  refreshToken: string;
}
