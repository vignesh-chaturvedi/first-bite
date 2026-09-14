import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createDatabase } from '../../src/db/client';
import { assertLocalFixtureUrl } from '../../src/db/url';
import { CampaignStore } from '../../src/lib/campaigns/store';
import { CampaignError } from '../../src/lib/campaigns/types';

const amount = z.string().regex(/^[1-9][0-9]{0,19}$/).transform(BigInt);
const campaignFile = z.object({
  slug: z.string(), name: z.string(), startsAt: z.iso.datetime().transform((value) => new Date(value)),
  endsAt: z.iso.datetime().transform((value) => new Date(value)), maxUsers: z.number().int(), capNative: amount,
  sponsorPublicKey: z.string(), limits: z.object({ maxRegistrationPrice: amount, maxTransactionFee: amount, recoveryAllowance: amount, maxReservation: amount }).strict(),
}).strict();

async function readCampaign(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8_192) throw new CampaignError('invalid_input');
    // Read at most the configured bound even if the file grows after stat.
    const bytes = Buffer.alloc(8_193);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 8_192) throw new CampaignError('invalid_input');
    return campaignFile.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally { await handle.close(); }
}

async function issuePrivate(store: CampaignStore, input: { campaignId?: string; wallet?: string; inviteId?: string }, expiry: string, filename: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}\.json$/.test(filename)) throw new CampaignError('invalid_input');
  const base = resolve('artifacts/private');
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (await realpath(base) !== base) throw new CampaignError('invalid_input');
  const path = resolve(base, filename);
  // Reserve an exclusive, private output before creating the invitation. Never overwrite.
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let inviteId: string | undefined;
  try {
    const invite = input.inviteId ? await store.rotateInvite({ inviteId: input.inviteId, expiresAt: new Date(expiry) })
      : await store.issueInvite({ campaignId: input.campaignId!, wallet: input.wallet!, expiresAt: new Date(expiry) });
    inviteId = invite.inviteId;
    await handle.writeFile(`${JSON.stringify({ ...input, ...invite, expiresAt: expiry }, null, 2)}\n`);
    await handle.sync();
    return { inviteId, outputFile: path };
  } catch (error) {
    if (inviteId) await store.revokeInvite(inviteId).catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  } finally { await handle.close(); }
}

let connection: ReturnType<typeof createDatabase> | undefined;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    input: { type: 'string' }, campaign: { type: 'string' }, wallet: { type: 'string' },
    expires: { type: 'string' }, out: { type: 'string' }, invite: { type: 'string' }, attempt: { type: 'string' },
  } });
  const command = positionals[0];
  const required: Record<string, string[]> = { create: ['input'], activate: ['campaign'], pause: ['campaign'], resume: ['campaign'], end: ['campaign'],
    inspect: ['campaign'], invites: ['campaign'], issue: ['campaign', 'wallet', 'expires', 'out'], rotate: ['invite', 'expires', 'out'], revoke: ['invite'], expire: ['attempt'], sweep: [] };
  const fields = command && required[command];
  if (!fields || positionals.length !== 1 || fields.some((field) => !values[field as keyof typeof values])
    || Object.keys(values).some((field) => !fields.includes(field))) throw new CampaignError('invalid_input');
  // Phase 3 operator commands are local metadata/accounting only. Production
  // operations remain gated until the live-wallet and deployment phases.
  const url = process.env.DATABASE_URL;
  if (!url) throw new CampaignError('storage_unavailable');
  assertLocalFixtureUrl(url, process.env.NODE_ENV ?? 'development');
  connection = createDatabase(url);
  const store = new CampaignStore(connection.pool);
  let result: unknown;
  switch (command) {
    case 'create': result = await store.createCampaign(await readCampaign(values.input!)); break;
    case 'activate': case 'resume': await store.setCampaignStatus(values.campaign!, 'active'); break;
    case 'pause': await store.setCampaignStatus(values.campaign!, 'paused'); break;
    case 'end': await store.setCampaignStatus(values.campaign!, 'ended'); break;
    case 'inspect': result = await store.inspectCampaign(values.campaign!); break;
    case 'invites': result = await store.listInvites(values.campaign!); break;
    case 'issue': result = await issuePrivate(store, { campaignId: values.campaign!, wallet: values.wallet! }, values.expires!, values.out!); break;
    case 'rotate': result = await issuePrivate(store, { inviteId: values.invite! }, values.expires!, values.out!); break;
    case 'revoke': await store.revokeInvite(values.invite!); break;
    case 'expire': result = { released: await store.expireUnsigned(values.attempt!) }; break;
    case 'sweep': result = await store.sweepUnsigned(); break;
  }
  console.log(JSON.stringify({ ok: true, command, result }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error instanceof CampaignError ? error.code : 'operator_command_failed' }));
  process.exitCode = 1;
} finally { await connection?.pool.end(); }
