import { executionRequest } from '@/server/execution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return executionRequest((handlers) => handlers.retry(request, id));
}
