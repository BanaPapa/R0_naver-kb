import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getApartmentDetail } from '../../../lib/applyhome/handlers.mjs';

// GET /api/apartments/:houseManageNo/detail — official links + 청약결과 tables.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const houseManageNo = String(req.query.houseManageNo || '');
  const { status, body } = await getApartmentDetail(houseManageNo, req.query as Record<string, string>);
  res.status(status).json(body);
}
