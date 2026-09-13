import { createDatabase } from '../../src/db/client.js';
import { seedDevelopmentFixture } from '../../src/db/fixtures.js';
import { assertLocalFixtureUrl, parseDatabaseUrl } from '../../src/db/url.js';

try {
  const url = parseDatabaseUrl(process.env.DATABASE_URL).toString();
  assertLocalFixtureUrl(url, process.env.NODE_ENV);
  const { db, pool } = createDatabase(url);
  try {
    await seedDevelopmentFixture(db);
    console.log(JSON.stringify({ level: 'info', event: 'database.fixtures_complete' }));
  } finally {
    await pool.end();
  }
} catch {
  console.error(JSON.stringify({ level: 'error', event: 'database.fixtures_failed', message: 'Use a migrated local first_bite_dev or first_bite_test database outside production' }));
  process.exitCode = 1;
}
