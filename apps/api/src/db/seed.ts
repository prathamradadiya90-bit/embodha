import { drizzle } from 'drizzle-orm/node-postgres';
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import * as schema from './schema';
import { seedDevData, seedReferenceData } from './seed-data';

/** `npm run db:seed` loads reference data. Add `--dev` for local test accounts and courses. */
async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const db = drizzle(pool, { schema });
    await seedReferenceData(db);
    if (process.argv.includes('--dev')) await seedDevData(db, { sampleVideoUrl: process.env.DEV_SAMPLE_VIDEO_URL });
    console.log(process.argv.includes('--dev') ? 'Reference and dev data loaded.' : 'Reference data loaded.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
