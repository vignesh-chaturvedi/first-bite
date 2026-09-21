import type { Pool } from 'pg';
import type { RuntimeConfig } from '../../config/schema';
import { executionIdentity } from './runtime-identity';
import { ExecutionError } from './types';

/**
 * First activation pins custody for this sponsor in the private database.
 * Never replace it automatically: old packets/attempt keys need the original
 * wrapping key, including during a rolling restart or a backup restoration.
 */
export async function assertRuntimeBinding(pool: Pool, config: RuntimeConfig): Promise<void> {
  const identity = executionIdentity(config);
  const key = `execution_identity:${config.sponsorPublicKey!}`;
  try {
    await pool.query(`INSERT INTO app_metadata (key,value)
      SELECT $1, jsonb_build_object('identity',$2::text)
      WHERE NOT EXISTS (SELECT 1 FROM quotes q JOIN campaigns c ON c.id=q.campaign_id
        WHERE c.sponsor_public_key=$3 AND q.encrypted_payer_key IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM attempts a JOIN campaigns c ON c.id=a.campaign_id
          WHERE c.sponsor_public_key=$3 AND a.encrypted_payer_key IS NOT NULL)
      ON CONFLICT (key) DO NOTHING`, [key, identity, config.sponsorPublicKey]);
    const row = (await pool.query<{ value: unknown }>('SELECT value FROM app_metadata WHERE key=$1', [key])).rows[0];
    if (!row || JSON.stringify(row.value) !== JSON.stringify({ identity })) throw new ExecutionError('policy_changed');
  } catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError('storage_unavailable');
  }
}
