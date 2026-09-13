import { migrateDatabase } from '../../src/db/migrate.js';
import { parseDatabaseUrl } from '../../src/db/url.js';

try {
  const url = parseDatabaseUrl(process.env.DATABASE_URL);
  await migrateDatabase(url.toString());
  console.log(JSON.stringify({ level: 'info', event: 'database.migrations_complete' }));
} catch {
  console.error(JSON.stringify({ level: 'error', event: 'database.migrations_failed', message: 'Check database connectivity, migration history, and whether another migration is running' }));
  process.exitCode = 1;
}
