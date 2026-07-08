// Vercel Serverless Function (Node) — 국토교통부 실거래가(apis.data.go.kr) 프록시 (프로덕션 전용).
// 개발: Vite proxy(vite.config.ts '/molit-api')가 대신 처리.
// 경로는 vercel.json rewrite 가 __path 쿼리로 전달한다 (zero-config catch-all 미지원 우회).
//
// serviceKey(공공데이터포털 인증키)는 이 서버측 함수만 알고 있으며(process.env.MOLIT_API_KEY),
// 응답으로 클라이언트에 노출되지 않는다. 소유자 단일 키(1일 1,000회)를 전 사용자가 공유한다.
import type { VercelRequest, VercelResponse } from '@vercel/node';

const MOLIT_BASE = 'https://apis.data.go.kr';

function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const rawKey = process.env.MOLIT_API_KEY ?? '';
  if (!rawKey) {
    res.status(500).json({ error: 'MOLIT_API_KEY 환경변수가 설정되지 않았습니다. (서버 관리자 설정 필요)' });
    return;
  }
  // 인코딩 키(%포함)는 그대로, 디코딩 키는 인코딩해서 사용.
  const serviceKey = rawKey.includes('%') ? rawKey : encodeURIComponent(rawKey);

  try {
    const subPath = first(req.query.__path);
    const target = new URL(`${MOLIT_BASE}/${subPath}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (key === '__path') continue;
      target.searchParams.set(key, first(value));
    }
    // serviceKey는 이미 인코딩된 문자열이므로 search 문자열에 직접 덧붙인다
    // (searchParams.set 은 %를 다시 이스케이프해 이중 인코딩됨).
    const sep = target.search ? '&' : '?';
    const url = `${target.toString()}${sep}serviceKey=${serviceKey}`;

    const upstream = await fetch(url, {
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      },
    });
    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/xml; charset=utf-8');
    res.send(text);
  } catch (err) {
    const e = err as { message?: string; cause?: { code?: string; message?: string } };
    res.status(502).json({
      proxyError: e?.message ?? String(err),
      causeCode: e?.cause?.code,
      causeMessage: e?.cause?.message,
    });
  }
}
