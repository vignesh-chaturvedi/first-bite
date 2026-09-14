import { campaignRequest } from '@/server/campaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  return campaignRequest((handlers) => handlers.publicCampaign(request, slug));
}
