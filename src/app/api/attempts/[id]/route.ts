import { campaignRequest } from '@/server/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return campaignRequest((handlers) => handlers.attempt(request, id));
}
