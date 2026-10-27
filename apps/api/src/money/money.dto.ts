import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class CourseCheckoutDto {
  @IsUUID()
  courseId: string;
}

/** Exactly what Razorpay Checkout hands back on success. */
export class ConfirmDto {
  @Matches(/^order_[A-Za-z0-9]+$/)
  orderId: string;

  @Matches(/^pay_[A-Za-z0-9]+$/)
  paymentId: string;

  @Matches(/^[a-f0-9]{64}$/)
  signature: string;
}

export class RefundDto {
  @IsString()
  @Length(3, 200)
  reason: string;
}

export class PaidDto {
  /** The UTR or reference from the bank transfer. */
  @IsString()
  @Length(2, 80)
  bankReference: string;
}

export class SubscriptionCheckoutDto {
  @IsUUID()
  instructorId: string;
}

/** What Razorpay Checkout hands back for a subscription. */
export class SubscriptionConfirmDto {
  @Matches(/^sub_[A-Za-z0-9]+$/)
  subscriptionId: string;

  @Matches(/^pay_[A-Za-z0-9]+$/)
  paymentId: string;

  @Matches(/^[a-f0-9]{64}$/)
  signature: string;
}

export class SellerDto {
  @IsString()
  @Length(1, 120)
  name: string;

  @IsString()
  @MaxLength(400)
  address: string;

  /** 15 characters, or empty until registered. The check digit is checked too, in the service. */
  @Matches(/^$|^[0-9A-Z]{15}$/, { message: 'GSTIN is 15 letters and digits' })
  gstin: string;

  /** The service code printed on invoices, e.g. 999293. Optional below ₹5 crore turnover; ask your accountant. */
  @IsOptional()
  @Matches(/^$|^\d{4,8}$/, { message: 'A SAC is 4 to 8 digits, e.g. 999293' })
  sac?: string;
}

export class MoneySettingsDto {
  /** Rupees per dollar for dollar sales, from the latest settlement report. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(1)
  @Max(1000)
  usdInrRate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  refundWindowDays?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  minPayoutPaise?: number;

  /** For instructors added from now on. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  defaultShareBps?: number;

  /** What Apple and Google keep of an in-app sale, on the price before GST. 15% under both small-business programmes. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  storeCommissionBps?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => SellerDto)
  seller?: SellerDto;

  /** Printed at the foot of invoices to buyers in India. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  noteIndia?: string;

  /** Printed at the foot of invoices to buyers abroad, e.g. the LUT under which no GST is charged. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  noteAbroad?: string;
}

export class TdsDto {
  /** Basis points: 1000 is 10%. */
  @IsInt()
  @Min(0)
  @Max(3000)
  tdsRateBps: number;
}

/** Razorpay's settlements for these days (YYYY-MM-DD), at most 31 of them. */
export class FetchSettlementsDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to: string;
}

/** Rupees for one unit of each currency an App Store report pays in, from that month's payment: { "USD": "84.12" }. */
export class RatesDto {
  @IsObject()
  rates: Record<string, string>;
}

export class ExplainDto {
  @IsString()
  @Length(3, 1000)
  explanation: string;
}
