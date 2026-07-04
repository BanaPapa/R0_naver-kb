// 분석/질문 요청 → 모델 메시지(system/user) 빌더 — 배포(서버리스) 경로용.
// 로컬 개발은 vite-plugins/analysis-runner.ts 의 buildMessages/buildAskMessages 가 같은
// 규칙으로 서버에서 조립한다. 형식을 바꿀 땐 두 곳을 함께 수정할 것.
import type { AnalysisRequest, AskRequest } from '../../../entities/analysis';
import analysisPrompt from '../prompts/analysis-prompt.md?raw';
import qaPrompt from '../prompts/analysis-qa-prompt.md?raw';

export interface ChatMessages {
  system: string;
  user: string;
}

export function buildAnalysisMessages(req: AnalysisRequest): ChatMessages {
  return {
    system: analysisPrompt,
    user: JSON.stringify({ scope: req.scope, datasets: req.datasets }, null, 2),
  };
}

export function buildAskMessages(req: AskRequest): ChatMessages {
  const history = (req.history ?? [])
    .map(t => `${t.role === 'user' ? '질문' : '답변'}: ${t.text}`)
    .join('\n\n');
  const user = [
    '## 직전 분석 결과',
    req.resultMarkdown ?? '(없음)',
    '',
    '## 원본 데이터(JSON)',
    JSON.stringify({ scope: req.scope, datasets: req.datasets }, null, 2),
    '',
    '## 이전 대화',
    history || '(없음)',
    '',
    '## 새 질문',
    req.question ?? '',
  ].join('\n');
  return { system: qaPrompt, user };
}
