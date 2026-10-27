import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

/** Applies pending migrations. The API container runs this before it starts. */
async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, '..', '..', 'drizzle') });
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
