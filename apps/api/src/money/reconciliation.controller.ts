import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthUser, CurrentUser, Roles, StaffGuard } from '../common/auth';
import { fail, uuidParam } from '../common/errors';
import { currentMonth } from '../common/month';
import { ExplainDto, FetchSettlementsDto, RatesDto } from './money.dto';
import { ReconciliationService } from './reconciliation.service';

/** Finance: what Razorpay, Google Play and the App Store say they paid, against the books. */
@ApiTags('admin')
@Controller('v1/admin/reconciliation')
@UseGuards(AuthGuard, StaffGuard)
@Roles('finance')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  overview(@Query('month') month?: string) {
    const chosen = month ?? currentMonth();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(chosen)) throw fail(400, 'invalid_month', 'Use a month like 2026-09.');
    return this.reconciliation.overview(chosen);
  }

  /** Razorpay's settlements for a few days, fetched now rather than waiting for the night. */
  @Post('razorpay')
  @HttpCode(200)
  fetch(@CurrentUser() me: AuthUser, @Body() dto: FetchSettlementsDto) {
    return this.reconciliation.fetchRazorpay(me.id, dto.from, dto.to);
  }

  /** A report as downloaded: Razorpay's settlement report, Play's earnings report (zip or CSV), or Apple's financial report (.txt or .gz). */
  @Post('upload')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  upload(@CurrentUser() me: AuthUser, @UploadedFile() file?: Express.Multer.File, @Body('rates') rates?: string) {
    if (!file?.buffer?.length) throw fail(400, 'no_file', 'Choose the report file to upload.');
    let parsed: Record<string, string> = {};
    if (rates) {
      try {
        parsed = JSON.parse(rates) as Record<string, string>;
      } catch {
        throw fail(400, 'invalid_rates', 'Rates should look like {"USD": "84.12"}.');
      }
    }
    return this.reconciliation.upload(me.id, file.originalname, file.buffer, parsed);
  }

  @Get('imports/:id')
  lines(@Param('id', uuidParam) id: string) {
    return this.reconciliation.lines(id);
  }

  @Post('imports/:id/rates')
  @HttpCode(200)
  rates(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string, @Body() dto: RatesDto) {
    return this.reconciliation.setRates(me.id, id, dto.rates);
  }

  @Post('lines/:id/explain')
  @HttpCode(200)
  explain(@CurrentUser() me: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: ExplainDto) {
    return this.reconciliation.explain(me.id, id, dto.explanation);
  }
}
