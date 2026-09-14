import { campaignRequest } from '@/server/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return campaignRequest((handlers) => handlers.reserve(request));
}
