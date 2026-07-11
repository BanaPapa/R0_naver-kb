import type { Plugin } from 'vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runProviderAnalysis } from './analysis-runner';

// dev 전용 분석 브릿지.
// 브라우저(앱)와 터미널의 Claude를 디스크 파일로 잇는다.
//   POST /api/analysis      → 요청 JSON을 .analysis/requests/<id>.json 으로 저장
//   GET  /api/analysis/:id  → .analysis/responses/<id>.md 가 있으면 결과 반환, 없으면 pending
// 추후 실제 모델 API로 교체할 때 이 두 핸들러만 바꾸면 프론트엔드는 무수정으로 동작한다.

const REQUESTS = '.analysis/requests';
const RESPONSES = '.analysis/responses';

function genId(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

// 응답 결과에 표시할 모델 라벨. 저장된 요청 JSON에서 실제 프로바이더/모델을 읽는다.
// claude-bridge(또는 모델 미지정)면 사람이 대행하므로 'claude-code'로 표기.
async function responseModelLabel(requestsDir: string, id: string): Promise<string> {
  const raw = await fs.readFile(path.join(requestsDir, `${id}.json`), 'utf8').catch(() => null);
  if (!raw) return 'claude-code';
  try {
    const r = JSON.parse(raw) as { provider?: string; model?: string | null };
    if (r.provider && r.provider !== 'claude-bridge') return r.model || r.provider;
  } catch {
    /* 잘못된 요청 파일은 기본값으로 폴백 */
  }
  return 'claude-code';
}

// 응답과 함께 저장된 토큰 사용량 사이드카(<id>.usage.json)를 읽는다. 없으면 undefined.
async function readUsage(responsesDir: string, id: string): Promise<unknown> {
  const raw = await fs.readFile(path.join(responsesDir, `${id}.usage.json`), 'utf8').catch(() => null);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

export function analysisBridge(): Plugin {
  return {
    name: 'analysis-bridge',
    apply: 'serve', // dev 서버에서만 활성화
    configureServer(server) {
      const root = server.config.root;
      const requestsDir = path.join(root, REQUESTS);
      const responsesDir = path.join(root, RESPONSES);

      void fs.mkdir(requestsDir, { recursive: true });
      void fs.mkdir(responsesDir, { recursive: true });

      server.middlewares.use('/api/analysis', (req, res, next) => {
        const method = req.method ?? 'GET';

        // POST /api/analysis — 새 분석 요청 저장
        if (method === 'POST') {
          void (async () => {
            try {
              const raw = await readBody(req);
              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                sendJson(res, 400, { error: '잘못된 JSON 요청입니다.' });
                return;
              }
              const id = genId();
              const record = { ...parsed, id, receivedAt: new Date().toISOString() };
              // 원자적 쓰기: 임시파일 → rename (부분 읽기 방지)
              const target = path.join(requestsDir, `${id}.json`);
              const tmp = `${target}.tmp`;
              await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
              await fs.rename(tmp, target);
              const provider = (parsed as { provider?: string }).provider;
              if (provider && provider !== 'claude-bridge') {
                void runProviderAnalysis(root, id, {
                  id,
                  kind: parsed.kind as string | undefined,
                  scope: parsed.scope,
                  datasets: parsed.datasets,
                  resultMarkdown: parsed.resultMarkdown as string | undefined,
                  history: parsed.history as { role: string; text: string }[] | undefined,
                  question: parsed.question as string | undefined,
                  provider: parsed.provider as string | undefined,
                  model: (parsed.model ?? null) as string | null,
                  // kind==='chat' 패스스루 (리뷰 분석)
                  system: parsed.system as string | undefined,
                  user: parsed.user as string | undefined,
                });
              }
              sendJson(res, 200, { id, status: 'pending' });
            } catch (err) {
              sendJson(res, 500, { error: err instanceof Error ? err.message : '요청 저장 실패' });
            }
          })();
          return;
        }

        // GET /api/analysis/:id — 응답 폴링
        if (method === 'GET') {
          const id = (req.url ?? '').replace(/^\//, '').split('?')[0]!.trim();
          if (!id || !/^[\w-]+$/.test(id)) {
            sendJson(res, 400, { error: '유효하지 않은 분석 id 입니다.' });
            return;
          }
          void (async () => {
            try {
              const errFile = path.join(responsesDir, `${id}.error.txt`);
              const errText = await fs.readFile(errFile, 'utf8').catch(() => null);
              if (errText != null) {
                sendJson(res, 200, { status: 'error', error: errText });
                return;
              }
              const file = path.join(responsesDir, `${id}.md`);
              const result = await fs.readFile(file, 'utf8').catch(() => null);
              if (result == null) {
                sendJson(res, 200, { status: 'pending' });
              } else {
                sendJson(res, 200, {
                  status: 'done',
                  result,
                  model: await responseModelLabel(requestsDir, id),
                  usage: await readUsage(responsesDir, id),
                });
              }
            } catch (err) {
              sendJson(res, 500, { error: err instanceof Error ? err.message : '응답 조회 실패' });
            }
          })();
          return;
        }

        next();
      });
    },
  };
}
