import type { AnalysisRequest, AnalysisResult, AskRequest } from '../model/analysis.types';
import { supabase } from '../../../../services/supabase';
import { buildAnalysisMessages, buildAskMessages } from '../../../features/analysis/lib/messages';

// 분석 실행 백엔드 — 환경별 분기:
//  - 개발: vite 브리지(/api/analysis) — 파일 큐 + 폴링. claude-bridge(세션 대행)와
//    직접 API 프로바이더 모두 지원.
//  - 배포: 서버리스(/api/kb-analysis) — 로그인 사용자의 자격증명(BYOK)으로 동기 실행.
//    메시지는 클라이언트에서 조립(lib/messages.ts, 러너와 동일 규칙).
const DEV = import.meta.env.DEV;

const BASE = '/api/analysis';

export interface PollOptions {
  intervalMs?: number; // 폴링 간격 (기본 1500ms)
  timeoutMs?: number; // 타임아웃 (기본 5분)
  signal?: AbortSignal; // 취소
}

// ── 배포 경로: 서버리스 동기 실행 ────────────────────────────
async function runServerless(
  payload: AnalysisRequest | AskRequest,
  opts: PollOptions,
): Promise<AnalysisResult> {
  if (!supabase) throw new Error('Supabase가 설정되지 않았습니다.');
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) throw new Error('로그인 후 사용할 수 있습니다.');

  const provider = payload.provider ?? '';
  if (!provider || provider === 'claude-bridge') {
    throw new Error('이 환경에서는 지원하지 않는 프로바이더입니다. 연결 관리에서 API 키 프로바이더를 선택해 주세요.');
  }
  if (!payload.model) throw new Error('모델을 선택해 주세요.');

  const messages =
    payload.kind === 'ask' ? buildAskMessages(payload as AskRequest) : buildAnalysisMessages(payload as AnalysisRequest);

  const res = await fetch('/api/kb-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({
      action: 'chat',
      provider,
      model: payload.model,
      system: messages.system,
      user: messages.user,
    }),
    signal: opts.signal,
  });
  const body = (await res.json().catch(() => ({}))) as {
    result?: string;
    model?: string;
    usage?: AnalysisResult['usage'];
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `분석 요청 실패 (${res.status})`);
  return { id: 'serverless', status: 'done', result: body.result ?? '', model: body.model, usage: body.usage };
}

// ── 개발 경로: 브리지 큐 + 폴링 ──────────────────────────────

// 분석 요청 전송 → 생성된 id 반환.
export async function postAnalysis(payload: AnalysisRequest | AskRequest): Promise<string> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`분석 요청 실패 (${res.status}) ${msg}`);
  }
  const data = (await res.json()) as { id?: string; error?: string };
  if (!data.id) throw new Error(data.error ?? '분석 id를 받지 못했습니다.');
  return data.id;
}

// 응답이 done 이 될 때까지 폴링. 타임아웃·취소 지원.
export async function pollAnalysis(id: string, opts: PollOptions = {}): Promise<AnalysisResult> {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException('취소됨', 'AbortError');

    const res = await fetch(`${BASE}/${id}`, { signal: opts.signal });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(`분석 조회 실패 (${res.status}) ${msg}`);
    }
    const data = (await res.json()) as Omit<AnalysisResult, 'id'>;
    if (data.status === 'done') return { id, ...data };
    if (data.status === 'error') throw new Error(data.error ?? '분석 중 오류가 발생했습니다.');

    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('분석이 지연되고 있습니다 (타임아웃).');
}

// 요청 전송 + 결과 수신을 한 번에.
export async function runAnalysis(
  payload: AnalysisRequest,
  opts: PollOptions = {},
): Promise<AnalysisResult> {
  if (!DEV) return runServerless(payload, opts);
  const id = await postAnalysis(payload);
  return pollAnalysis(id, opts);
}

// 질문 요청 — 분석과 동일 경로 재사용.
export async function runAsk(payload: AskRequest, opts: PollOptions = {}): Promise<AnalysisResult> {
  if (!DEV) return runServerless(payload, opts);
  const id = await postAnalysis(payload);
  return pollAnalysis(id, opts);
}
