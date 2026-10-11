import { handler } from '../../../../lib/server';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ action: string }> }) {
  return handler(request, (await params).action);
}
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  return handler(request, (await params).action);
}
