import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import * as schema from './schema';

export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;
export const InjectDb = () => Inject(DB);

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ENV],
      useFactory: (env: Env): Db => drizzle(new Pool({ connectionString: env.DATABASE_URL, max: 10 }), { schema }),
    },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@InjectDb() private readonly db: Db) {}

  async onApplicationShutdown() {
    const client = (this.db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
    await client?.end?.();
  }
}
