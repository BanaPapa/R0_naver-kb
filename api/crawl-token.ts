// Vercel Serverless Function — 승인된 사용자에게 단기 크롤 토큰 발급
// 에이전트가 네이버 프록시 요청 시 X-Crawl-Token 헤더로 이 토큰을 전달한다.
// 실제 발급 로직은 lib/crawlTokenCore.ts(로컬 Vite 미들웨어와 공용)에 있다.
import type { VercelRequest, VercelResponse } from '@vercel/node';
// 공유 코어는 api/ 밖(lib/)에 둔다. api/ 안의 `_` 접두 형제 모듈을 import하면
// Vercel이 그 파일을 배포에서 제외해 런타임에 FUNCTION_INVOCATION_FAILED로 크래시한다.
import { issueCrawlToken } from '../lib/crawlTokenCore';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  // Supabase access token 추출
  const auth = req.headers.authorization ?? '';
  const accessToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  const { status, body } = await issueCrawlToken(accessToken, {
    supabaseUrl: process.env.VITE_SUPABASE_URL,
    supabaseKey: process.env.VITE_SUPABASE_ANON_KEY,
    secret: process.env.CRAWL_TOKEN_SECRET,
  });

  res.status(status).json(body);
}
