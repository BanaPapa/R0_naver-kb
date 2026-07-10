import type { Plugin } from 'vite';
import { listReviewApartments } from '../api/reviews/apartments';

async function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

export function reviewApi(): Plugin {
  return { name: 'review-api', apply: 'serve', configureServer(server) {
    server.middlewares.use('/api/reviews/apartments', (req, res) => { void (async () => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST만 지원합니다.' })); return; }
      try { const body = await readBody(req); const out = await listReviewApartments(body.legalCode, body.listType); res.statusCode = out.status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out.body)); }
      catch (err) { res.statusCode = 500; res.end(JSON.stringify({ error: err instanceof Error ? err.message : '요청 처리 실패' })); }
    })(); });
  } };
}
