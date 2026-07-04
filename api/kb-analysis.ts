// Vercel Serverless Function — 배포 환경의 AI 분석 실행/모델 목록 (BYOK).
//
// 로그인 사용자의 자격증명(kb_user_providers, RLS 본인 전용)을 사용자 JWT로 조회해
// 그 사용자의 키로 프로바이더 API를 호출한다. 키는 응답에 포함되지 않는다.
//
// 요청: POST { action: 'chat'|'models', provider, model?, system?, user? }
//   헤더: Authorization: Bearer <supabase access token>
// 응답: chat → { result, model, usage? } · models → ModelInfo[]
//
// ⚠️ 이 함수는 의도적으로 self-contained(상대경로 import 0개)다.
//   이 Vercel 프로젝트에서는 api/ 함수가 상대경로 모듈을 import하면 런타임 번들에서
//   빠져 FUNCTION_INVOCATION_FAILED로 죽는다(api/crawl-token.ts 참고). 어댑터 로직은
//   vite-plugins/adapters/*(로컬 개발용)와 동일 규칙의 인라인 사본이다 — 함께 수정할 것.
//
// 구독 OAuth(ChatGPT 등)는 콜백이 localhost 전용이라 배포에서는 미지원 — API 키만.
import type { VercelRequest, VercelResponse } from '@vercel/node';

// ── 프로바이더 정의 (src/kb/entities/provider/model/registry.ts 의 서버 사본) ──
type Shape = 'openai-compatible' | 'anthropic' | 'gemini';
interface Def {
  shape: Shape;
  baseUrl: string;
  publicModelList?: boolean;
}
const DEFS: Record<string, Def> = {
  openai: { shape: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
  xai: { shape: 'openai-compatible', baseUrl: 'https://api.x.ai/v1' },
  anthropic: { shape: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  openrouter: { shape: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', publicModelList: true },
  google: { shape: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  deepseek: { shape: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
  groq: { shape: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
  mistral: { shape: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1' },
  together: { shape: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1' },
};

interface Credential {
  method?: string;
  apiKey?: string;
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
}
interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

const keyOf = (c: Credential): string | undefined => c.apiKey ?? c.accessToken ?? c.token;
// 구독(ChatGPT Codex) 자격증명인가 — OpenAI + subscription 토큰이면 codex 백엔드를 쓴다.
const isCodex = (provider: string, c: Credential): boolean =>
  provider === 'openai' && c.method === 'subscription' && Boolean(c.accessToken);
const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
const CODEX_VERSION = '0.0.0';

async function asJson(res: Response, label: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${label} 오류 (${res.status}) ${await res.text().catch(() => '')}`);
  return (await res.json()) as Record<string, unknown>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ── 어댑터 (인라인) ──────────────────────────────────────────
async function chatOpenAi(def: Def, cred: Credential, model: string, system: string, user: string) {
  const key = keyOf(cred);
  if (!key) throw new Error('자격증명이 없습니다.');
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (def.baseUrl.includes('openrouter')) body.usage = { include: true };
  const json = await asJson(
    await fetch(`${def.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    '프로바이더',
  );
  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  const u = (json.usage ?? {}) as Record<string, unknown>;
  const usage: Usage = {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
    cost: num(u.cost),
  };
  return { text: choices?.[0]?.message?.content ?? '', usage };
}

async function chatAnthropic(def: Def, cred: Credential, model: string, system: string, user: string) {
  if (!cred.apiKey) throw new Error('자격증명이 없습니다.');
  const json = await asJson(
    await fetch(`${def.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
    }),
    'Anthropic',
  );
  const content = json.content as { text?: string }[] | undefined;
  const u = json.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const promptTokens = num(u?.input_tokens);
  const completionTokens = num(u?.output_tokens);
  return {
    text: content?.map(c => c.text ?? '').join('') ?? '',
    usage: { promptTokens, completionTokens, totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) || undefined },
  };
}

async function chatGemini(def: Def, cred: Credential, model: string, system: string, user: string) {
  const key = keyOf(cred);
  if (!key) throw new Error('자격증명이 없습니다.');
  const json = await asJson(
    await fetch(`${def.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
      }),
    }),
    'Gemini',
  );
  const candidates = json.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
  const u = json.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
  return {
    text: candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '',
    usage: { promptTokens: num(u?.promptTokenCount), completionTokens: num(u?.candidatesTokenCount), totalTokens: num(u?.totalTokenCount) },
  };
}

async function listModels(def: Def, cred: Credential): Promise<unknown[]> {
  const key = keyOf(cred);
  if (def.shape === 'gemini') {
    if (!key) throw new Error('자격증명이 없습니다.');
    const json = await asJson(await fetch(`${def.baseUrl}/models?key=${key}`), 'Gemini');
    return ((json.models as { name: string }[]) ?? []).map(m => ({ id: m.name.replace(/^models\//, '') }));
  }
  if (def.shape === 'anthropic') {
    if (!cred.apiKey) throw new Error('자격증명이 없습니다.');
    const json = await asJson(
      await fetch(`${def.baseUrl}/models`, { headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01' } }),
      'Anthropic',
    );
    return ((json.data as { id: string }[]) ?? []).map(m => ({ id: m.id }));
  }
  // openai-compatible — openrouter는 키 없이도 공개 목록 제공
  if (!key && !def.publicModelList) throw new Error('자격증명이 없습니다.');
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const json = await asJson(await fetch(`${def.baseUrl}/models`, { headers }), '프로바이더');
  const data = (json.data as { id: string; name?: string; created?: number; context_length?: number; pricing?: { prompt?: string; completion?: string } }[]) ?? [];
  return data.map(m => {
    const promptPrice = m.pricing?.prompt != null ? Number(m.pricing.prompt) : undefined;
    const completionPrice = m.pricing?.completion != null ? Number(m.pricing.completion) : undefined;
    return {
      id: m.id,
      label: m.name,
      created: m.created,
      promptPrice: Number.isFinite(promptPrice) ? promptPrice : undefined,
      completionPrice: Number.isFinite(completionPrice) ? completionPrice : undefined,
      contextLength: m.context_length,
      isFree: m.id.endsWith(':free') || (promptPrice === 0 && completionPrice === 0),
    };
  });
}

// ── Supabase: 사용자 검증 + 본인 자격증명 조회 (사용자 JWT로 RLS 적용) ──
async function getCredential(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string,
  provider: string,
): Promise<Credential | null> {
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: anonKey },
  });
  if (!userRes.ok) return null; // 유효하지 않은 세션
  const rowsRes = await fetch(
    `${supabaseUrl}/rest/v1/kb_user_providers?select=credential&provider_id=eq.${encodeURIComponent(provider)}`,
    { headers: { Authorization: `Bearer ${accessToken}`, apikey: anonKey } },
  );
  if (!rowsRes.ok) throw new Error(`자격증명 조회 실패 (${rowsRes.status})`);
  const rows = (await rowsRes.json()) as { credential?: Credential }[];
  return rows[0]?.credential ?? { method: 'none' };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST만 지원합니다.' });
    return;
  }
  // body.credential 이 오면 "이번만 사용"(session) 모드 — 서버 조회 없이 그대로 사용.
  // 없으면 "계정 저장"(account) 모드 — 사용자 JWT로 Supabase에서 본인 자격증명 조회.
  const body = (req.body ?? {}) as {
    action?: string;
    provider?: string;
    model?: string;
    system?: string;
    user?: string;
    credential?: Credential;
  };
  const { action, provider, model, system, user } = body;
  const def = provider ? DEFS[provider] : undefined;
  if (!def) {
    res.status(400).json({ error: `지원하지 않는 프로바이더: ${provider}` });
    return;
  }

  try {
    let cred: Credential;
    if (body.credential) {
      cred = body.credential; // session 모드 — 서버 무저장
    } else {
      const supabaseUrl = process.env.VITE_SUPABASE_URL;
      const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !anonKey) {
        res.status(500).json({ error: 'Supabase 환경변수 미설정' });
        return;
      }
      const accessToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!accessToken) {
        res.status(401).json({ error: '로그인이 필요합니다.' });
        return;
      }
      const found = await getCredential(supabaseUrl, anonKey, accessToken, provider!);
      if (found === null) {
        res.status(401).json({ error: '유효하지 않은 세션입니다. 다시 로그인해 주세요.' });
        return;
      }
      cred = found;
    }

    const codex = isCodex(provider!, cred);
    const hasKey = Boolean(keyOf(cred));

    if (action === 'models') {
      if (!hasKey && !def.publicModelList) {
        res.status(400).json({ error: '먼저 연결 관리에서 API 키 또는 구독을 연결해 주세요.' });
        return;
      }
      res.status(200).json(codex ? await codexModels(cred) : await listModels(def, cred));
      return;
    }

    if (action === 'chat') {
      if (!hasKey) {
        res.status(400).json({ error: '먼저 연결 관리에서 API 키 또는 구독을 연결해 주세요.' });
        return;
      }
      if (!model || !system || !user) {
        res.status(400).json({ error: 'model/system/user가 필요합니다.' });
        return;
      }
      const result = codex
        ? await codexChat(cred, model, system, user)
        : await (def.shape === 'anthropic' ? chatAnthropic : def.shape === 'gemini' ? chatGemini : chatOpenAi)(def, cred, model, system, user);
      res.status(200).json({ result: result.text || '_빈 응답_', model, usage: result.usage });
      return;
    }

    res.status(400).json({ error: `알 수 없는 action: ${action}` });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : '프로바이더 호출 실패' });
  }
}

// ── ChatGPT Codex (구독) — P1_Reviewer chatgptCodex 어댑터의 인라인 사본 ──
function codexHeaders(cred: Credential): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${cred.accessToken}`,
    originator: 'codex_cli_rs',
    'User-Agent': `codex_cli_rs/${CODEX_VERSION} kb-web`,
    version: CODEX_VERSION,
  };
  if (cred.accountId) h['chatgpt-account-id'] = cred.accountId;
  return h;
}

async function codexModels(cred: Credential): Promise<unknown[]> {
  const res = await fetch(`${CODEX_BASE}/models?client_version=${CODEX_VERSION}`, {
    headers: { ...codexHeaders(cred), Accept: 'application/json' },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ChatGPT 구독 모델 조회 오류 (${res.status}) ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw) as { models?: { slug?: string; display_name?: string; visibility?: string; supported_in_api?: boolean; context_window?: number }[] };
  return (json.models ?? [])
    .filter(m => m.slug && m.visibility === 'list' && m.supported_in_api !== false)
    .map(m => ({ id: m.slug, label: m.display_name ?? m.slug, contextLength: m.context_window }));
}

function codexTextFromOutput(output: { content?: { type?: string; text?: string }[] }[] | undefined): string {
  if (!Array.isArray(output)) return '';
  return output.flatMap(i => i.content ?? []).filter(c => c.type === 'output_text' && typeof c.text === 'string').map(c => c.text as string).join('');
}

async function codexChat(cred: Credential, model: string, system: string, user: string): Promise<{ text: string; usage?: Usage }> {
  const res = await fetch(`${CODEX_BASE}/responses`, {
    method: 'POST',
    headers: { ...codexHeaders(cred), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model,
      instructions: system,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }],
      store: false,
      stream: true,
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ChatGPT 구독 오류 (${res.status}) ${raw.slice(0, 300)}`);
  // SSE 또는 단일 JSON 파싱
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { output?: { content?: { type?: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
      const u = j.usage;
      return { text: codexTextFromOutput(j.output), usage: u ? { promptTokens: num(u.input_tokens), completionTokens: num(u.output_tokens), totalTokens: num(u.total_tokens) } : undefined };
    } catch { /* SSE 폴백 */ }
  }
  let text = '';
  let usage: Usage | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const p = m[1]!.trim();
    if (!p || p === '[DONE]') continue;
    let evt: { type?: string; delta?: string; response?: { output?: { content?: { type?: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } };
    try { evt = JSON.parse(p); } catch { continue; }
    if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') text += evt.delta;
    else if (evt.type === 'response.completed' && evt.response) {
      const u = evt.response.usage;
      if (u) usage = { promptTokens: num(u.input_tokens), completionTokens: num(u.output_tokens), totalTokens: num(u.total_tokens) };
      if (!text) text = codexTextFromOutput(evt.response.output);
    }
  }
  return { text, usage };
}
