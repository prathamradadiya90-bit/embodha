import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { Db, InjectDb } from './db/db.module';

@ApiExcludeController()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Used by the Docker healthcheck and the uptime monitor. Fails if the database is unreachable. */
  @Get()
  async check() {
    await this.db.execute(sql`select 1`);
    return { ok: true };
  }
}
