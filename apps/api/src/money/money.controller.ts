import { Body, Controller, Get, Headers, HttpCode, HttpException, Param, Post, Put, Req, StreamableFile, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthGuard, AuthUser, CurrentInstructor, CurrentUser, InstructorGuard, InstructorRef, Roles, StaffGuard } from '../common/auth';
import { fail, uuidParam } from '../common/errors';
import { heard } from '../common/webhooks';
import { Db, InjectDb } from '../db/db.module';
import { GstReportService } from './gst-report.service';
import { InvoicesService } from './invoices.service';
import { MoneySettingsService } from './money-settings.service';
import { ConfirmDto, CourseCheckoutDto, MoneySettingsDto, PaidDto, RefundDto, SubscriptionCheckoutDto, SubscriptionConfirmDto, TdsDto } from './money.dto';
import { PaymentsService } from './payments.service';
import { PayoutsService } from './payouts.service';
import { RazorpayService, RazorpaySubscription } from './razorpay.service';
import { SubscriptionsService } from './subscriptions.service';

const monthParam = (month: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail(400, 'invalid_month', 'Use a month like 2026-09.');
  return month;
};

interface RazorpayEvent {
  event: string;
  payload: {
    payment?: { entity: { id: string } };
    refund?: { entity: { id: string; payment_id: string } };
    subscription?: { entity: RazorpaySubscription };
  };
}

@ApiTags('payments')
@Controller('v1')
export class MoneyController {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly payments: PaymentsService,
    private readonly razorpay: RazorpayService,
    private readonly subscriptions: SubscriptionsService,
    private readonly invoices: InvoicesService,
  ) {}

  /** Opens a Razorpay order for a course. Pass the result to Razorpay Checkout. */
  @Post('checkout/course')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  start(@CurrentUser() me: AuthUser, @Body() dto: CourseCheckoutDto) {
    return this.payments.startCourseCheckout(me.id, dto.courseId);
  }

  /** Called with Checkout's success response. Unlocks the course straight away. */
  @Post('checkout/confirm')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  confirm(@CurrentUser() me: AuthUser, @Body() dto: ConfirmDto) {
    return this.payments.confirm(me.id, dto);
  }

  /** Opens a Razorpay subscription to one instructor. Pass the result to Razorpay Checkout as subscription_id. */
  @Post('checkout/subscription')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  subscribe(@CurrentUser() me: AuthUser, @Body() dto: SubscriptionCheckoutDto) {
    return this.subscriptions.start(me.id, dto.instructorId);
  }

  @Post('checkout/subscription/confirm')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  confirmSubscription(@CurrentUser() me: AuthUser, @Body() dto: SubscriptionConfirmDto) {
    return this.subscriptions.confirm(me.id, dto);
  }

  /** Stops renewal; access runs to the end of the paid month. */
  @Post('me/subscriptions/:id/cancel')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  cancel(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    return this.subscriptions.cancel(me.id, id);
  }

  /** The PDF invoice, for the member who paid or for finance and support staff. */
  @Get('payments/:id/invoice')
  @UseGuards(AuthGuard)
  async invoice(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    const { filename, pdf } = await this.invoices.pdfFor(id, me.id);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `inline; filename="${filename}"` });
  }

  /** The credit note for a refunded invoice, for the same people. */
  @Get('payments/:id/credit-note')
  @UseGuards(AuthGuard)
  async creditNote(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    const { filename, pdf } = await this.invoices.pdfFor(id, me.id, 'credit_note');
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `inline; filename="${filename}"` });
  }

  @Get('me/purchases')
  @UseGuards(AuthGuard)
  purchases(@CurrentUser() me: AuthUser) {
    return this.payments.purchases(me.id);
  }

  @Get('studio/earnings')
  @UseGuards(AuthGuard, InstructorGuard)
  earnings(@CurrentInstructor() me: InstructorRef) {
    return this.payments.earnings(me.id);
  }

  /**
   * Razorpay's webhook (payment.captured, refund.processed). It covers members who close the app before Checkout
   * returns. Anything Embodha doesn't handle still gets a 200, so Razorpay stops retrying it.
   */
  @Post('webhooks/razorpay')
  @HttpCode(200)
  @SkipThrottle()
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature?: string) {
    if (!this.razorpay.webhookSignatureValid(req.rawBody, signature)) throw fail(401, 'bad_signature', 'Signature check failed.');
    const { event, payload } = req.body as RazorpayEvent;
    await heard(this.db, 'razorpay', event);
    try {
      if (event === 'subscription.charged' && payload.subscription && payload.payment) {
        await this.subscriptions.charge(payload.subscription.entity.id, payload.payment.entity.id);
      } else if (event.startsWith('subscription.') && payload.subscription) await this.subscriptions.statusFromRazorpay(payload.subscription.entity);
      else if (event === 'payment.captured' && payload.payment) await this.payments.record(payload.payment.entity.id);
      else if (event === 'refund.processed' && payload.refund) await this.payments.refundFromRazorpay(payload.refund.entity.payment_id, payload.refund.entity.id);
      else return { ignored: event };
    } catch (error) {
      // A 4xx means "not ours" (another kind of order, say); only server trouble should make Razorpay retry.
      if (error instanceof HttpException && error.getStatus() < 500) return { ignored: event, reason: (error.getResponse() as { code?: string }).code };
      throw error;
    }
    return { ok: true };
  }
}

/** Finance: payments and refunds, and the month-end payout statements. Support can look up payments too. */
@ApiTags('admin')
@Controller('v1/admin')
@UseGuards(AuthGuard, StaffGuard)
export class MoneyAdminController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly payouts: PayoutsService,
    private readonly settings: MoneySettingsService,
    private readonly gst: GstReportService,
  ) {}

  /** A month of invoices and credit notes for the GST returns: by place of supply, exports, and line by line. */
  @Get('reports/gst/:month')
  @Roles('finance')
  gstReport(@Param('month') month: string) {
    return this.gst.month(monthParam(month));
  }

  @Get('money-settings')
  @Roles('finance')
  moneySettings() {
    return this.settings.get();
  }

  @Put('money-settings')
  @Roles('finance')
  updateMoneySettings(@CurrentUser() me: AuthUser, @Body() dto: MoneySettingsDto) {
    return this.settings.update(me.id, dto);
  }

  @Put('instructors/:id/tds')
  @Roles('finance')
  tds(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: TdsDto) {
    return this.settings.setTds(me.id, id, dto.tdsRateBps);
  }

  @Get('payments')
  @Roles('finance', 'support')
  list() {
    return this.payments.list();
  }

  @Post('payments/:id/refund')
  @HttpCode(200)
  @Roles('finance')
  refund(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: RefundDto) {
    return this.payments.refund(me.id, id, dto.reason.trim());
  }

  @Get('payouts')
  @Roles('finance')
  statements() {
    return this.payouts.list();
  }

  @Get('payouts/:month')
  @Roles('finance')
  statement(@Param('month') month: string) {
    return this.payouts.get(monthParam(month));
  }

  @Post('payouts/:month/prepare')
  @HttpCode(200)
  @Roles('finance')
  prepare(@CurrentUser() me: AuthUser, @Param('month') month: string) {
    return this.payouts.prepare(me.id, monthParam(month));
  }

  @Post('payouts/:month/close')
  @HttpCode(200)
  @Roles('finance')
  close(@CurrentUser() me: AuthUser, @Param('month') month: string) {
    return this.payouts.close(me.id, monthParam(month));
  }

  @Post('payout-lines/:id/paid')
  @HttpCode(200)
  @Roles('finance')
  paid(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: PaidDto) {
    return this.payouts.markPaid(me.id, id, dto.bankReference);
  }
}
