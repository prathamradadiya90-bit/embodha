import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AuthGuard, AuthUser, CurrentUser, Roles, StaffGuard } from '../common/auth';
import { fail, uuidParam } from '../common/errors';
import { GooglePlayClient } from './google-play.client';
import { StoreOfferQuery, StoreOwnerDto, StoreProductDto, StoreVerifyDto } from './store.dto';
import { StoreSyncService } from './store-sync.service';
import { StoreService } from './store.service';

/** Store webhooks answer 200 to anything that isn't ours, so the store stops retrying; only our own trouble earns a retry. */
async function quietly<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException && error.getStatus() < 500) return { ignored: (error.getResponse() as { code?: string }).code ?? 'rejected' };
    throw error;
  }
}

@ApiTags('payments')
@Controller('v1')
export class StoreController {
  constructor(
    private readonly store: StoreService,
    private readonly google: GooglePlayClient,
  ) {}

  /** After the App Store or Google Play says a purchase went through. Unlocks once the store confirms it to us. */
  @Post('store/verify')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  verify(@CurrentUser() me: AuthUser, @Body() dto: StoreVerifyDto) {
    return this.store.verify(me.id, dto);
  }

  /** Which store products sell this course or subscription. */
  @Get('store/offer')
  offer(@Query() query: StoreOfferQuery) {
    return this.store.offer(query);
  }

  /** App Store Server Notifications V2. Set this URL for production and sandbox in App Store Connect. */
  @Post('webhooks/apple')
  @HttpCode(200)
  @SkipThrottle()
  apple(@Body() body: unknown) {
    return quietly(() => this.store.appleNotification((body as { signedPayload?: unknown } | null)?.signedPayload));
  }

  /** Google Play real-time developer notifications, through a Pub/Sub push subscription. */
  @Post('webhooks/google')
  @HttpCode(200)
  @SkipThrottle()
  googlePlay(@Query('secret') secret: string | undefined, @Body() body: unknown) {
    if (!this.google.notificationSecretValid(secret)) throw fail(401, 'bad_secret', 'Secret check failed.');
    return quietly(() => this.store.playNotification(body));
  }
}

/** Linking App Store and Google Play products to courses and subscriptions. */
@ApiTags('admin')
@Controller('v1/admin')
@UseGuards(AuthGuard, StaffGuard)
export class StoreAdminController {
  constructor(
    private readonly store: StoreService,
    private readonly sync: StoreSyncService,
  ) {}

  @Get('store-products')
  @Roles('content', 'finance')
  async list() {
    const list = await this.store.adminList();
    const ids = [...list.courses.map((c) => c.id), ...list.plans.map((p) => p.instructorId)];
    return { ...list, automation: this.sync.automation(), working: this.sync.busy(ids) };
  }

  /** Makes or finishes one course's or teacher's store products now, in the background; the page shows progress. */
  @Post('store-products/sync')
  @HttpCode(202)
  @Roles('content', 'finance')
  syncOne(@Body() dto: StoreOwnerDto) {
    if (!this.sync.automation().apple && !this.sync.automation().google) throw fail(409, 'store_not_configured', 'Neither store has product keys set on this server yet.');
    this.sync.request({ type: dto.ownerType, id: dto.ownerId });
    return { started: true };
  }

  /** What the half-hourly sweep does, on demand: retries, review checks, and anything on sale without products. */
  @Post('store-products/sweep')
  @HttpCode(202)
  @Roles('content', 'finance')
  sweep() {
    if (!this.sync.automation().apple && !this.sync.automation().google) throw fail(409, 'store_not_configured', 'Neither store has product keys set on this server yet.');
    void this.sync.sweep().catch(() => undefined);
    return { started: true };
  }

  @Put('store-products')
  @Roles('content', 'finance')
  save(@CurrentUser() me: AuthUser, @Body() dto: StoreProductDto) {
    return this.store.saveProduct(me.id, dto);
  }

  @Delete('store-products/:id')
  @Roles('content', 'finance')
  remove(@CurrentUser() me: AuthUser, @Param('id', uuidParam) id: string) {
    return this.store.removeProduct(me.id, id);
  }
}
