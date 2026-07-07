import type { VercelRequest, VercelResponse } from '@vercel/node';
import { searchApartments } from '../../lib/applyhome/handlers.mjs';

// GET /api/apartments/search — live crawl of applyhome, paginated.
// Shares the same handler the Vite dev plugin uses locally.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const { status, body } = await searchApartments(req.query as Record<string, string>);
  res.status(status).json(body);
}
