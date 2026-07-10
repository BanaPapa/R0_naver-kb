import type { VercelRequest, VercelResponse } from '@vercel/node';

const HGNN_API = 'https://hogangnono.com/api';
const HGNN_AT = 'B-7W6GsCNz-Bnrknn4UW7-kyG2TUs8gxwMpg';

export function areaCode(legalCode: unknown): string | null {
  const code = String(legalCode ?? '').replace(/\D/g, '');
  return code.length >= 8 ? `${code.slice(0, 8)}00` : null;
}

export async function listReviewApartments(legalCode: unknown, listType: unknown) {
  const area = areaCode(legalCode);
  if (!area) return { status: 400, body: { error: '유효한 법정동 코드가 필요합니다.' } };
  if (listType !== 'apt-all' && listType !== 'ot-all') return { status: 400, body: { error: '지원하지 않는 주택 유형입니다.' } };
  const response = await fetch(`${HGNN_API}/region/${area}/apt?areaRoughly=0`, { headers: {
    Accept: 'application/json', Referer: 'https://hogangnono.com/',
    'x-hogangnono-api-version': '2.5.0', 'x-hogangnono-app-name': 'hogangnono', 'x-hogangnono-at': HGNN_AT,
    'x-hogangnono-ct': String(Date.now()), 'x-hogangnono-platform': 'desktop', 'x-hogangnono-release-version': '2.5.0.38',
  } });
  if (response.status === 404) return { status: 200, body: [] };
  if (!response.ok) return { status: 502, body: { error: `단지 목록 조회 실패 (${response.status})` } };
  const json = await response.json() as any;
  const rows = listType === 'apt-all' ? json?.data?.apts ?? [] : json?.data?.officetels ?? [];
  return { status: 200, body: rows.map((x: any) => ({ id: String(x.id), name: x.name ?? '', address: x.address ?? '', dong: x.dong ?? '', type: listType })).sort((a: any, b: any) => a.name.localeCompare(b.name, 'ko')) };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST만 지원합니다.' }); return; }
  try {
    const result = await listReviewApartments(req.body?.legalCode, req.body?.listType);
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '단지 목록 조회 중 오류가 발생했습니다.' });
  }
}
