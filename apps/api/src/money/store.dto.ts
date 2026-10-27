import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';

/** Works in both stores: Apple allows more, Google allows only lowercase letters, digits, dots and underscores. */
export const PRODUCT_ID = /^[a-z0-9][a-z0-9._]{1,99}$/;

/**
 * What the app sends once the store says a purchase went through. iOS sends the transaction ID; Android sends the
 * product and the purchase token. The server asks the store about it before anything unlocks.
 */
export class StoreVerifyDto {
  @IsIn(['apple', 'google'])
  store: 'apple' | 'google';

  @IsOptional()
  @Matches(/^\d{1,40}$/, { message: 'transactionId must be the App Store transaction ID' })
  transactionId?: string;

  @IsOptional()
  @Matches(PRODUCT_ID, { message: 'productId is not a store product ID' })
  productId?: string;

  @IsOptional()
  @Length(10, 4096)
  @Matches(/^[A-Za-z0-9._-]+$/, { message: 'purchaseToken is not a Google Play purchase token' })
  purchaseToken?: string;
}

export class StoreOfferQuery {
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @IsOptional()
  @IsUUID()
  instructorId?: string;
}

/** Admin: make (or finish making) the store products for one course or teacher now. */
export class StoreOwnerDto {
  @IsIn(['course', 'instructor_plan'])
  ownerType: 'course' | 'instructor_plan';

  @IsUUID()
  ownerId: string;
}

/** Admin: the product that sells a course or an instructor's subscription in one store. */
export class StoreProductDto {
  @IsIn(['course', 'instructor_plan'])
  ownerType: 'course' | 'instructor_plan';

  @IsUUID()
  ownerId: string;

  @IsIn(['apple', 'google'])
  store: 'apple' | 'google';

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(PRODUCT_ID, { message: 'Use lowercase letters, digits, dots and underscores, like course.morning_flow' })
  productId: string;

  @IsIn(['pending', 'in_review', 'live', 'failed', 'off_sale'])
  status: 'pending' | 'in_review' | 'live' | 'failed' | 'off_sale';

  /** What went wrong, when the status is "failed": a rejection from review, a price that doesn't match. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
