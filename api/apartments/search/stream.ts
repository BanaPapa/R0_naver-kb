import type { VercelRequest, VercelResponse } from '@vercel/node';
import { streamSearch } from '../../../lib/applyhome/handlers.mjs';

// GET /api/apartments/search/stream — Server-Sent Events with live progress.
// NOTE: serverless functions have an execution-time limit (Hobby ~10s, Pro 60s,
// Fluid Compute longer). Large pages may need batching at integration time.
export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  await streamSearch(req.query as Record<string, string>, req, res);
}
