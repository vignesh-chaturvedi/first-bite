import type { Database } from './client';
import { appMetadata } from './schema';

export const DEVELOPMENT_FIXTURE = {
  key: 'development_fixture',
  value: { project: 'First Bite', phase: 1, funded: false },
} as const;

/** CLI restricts this fixture to local development/test databases. */
export async function seedDevelopmentFixture(db: Database): Promise<void> {
  await db.insert(appMetadata).values(DEVELOPMENT_FIXTURE).onConflictDoUpdate({
    target: appMetadata.key,
    set: { value: DEVELOPMENT_FIXTURE.value },
  });
}
