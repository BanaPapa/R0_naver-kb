export type ApiShape = 'openai-compatible' | 'anthropic' | 'gemini' | 'claude-bridge' | 'chatgpt-codex';
export type AuthMethod = 'apiKey' | 'subscription';
// device-code: 팝업/콜백 없이 1회용 코드 표시 + 폴링 (배포 환경 작동 — OpenAI Codex).
// oauth-code: 동의 화면이 코드를 표시 → 사용자가 복사·붙여넣기 (배포 작동 — xAI).
// oauth-pkce: https 콜백으로 자동 복귀 (배포 작동 — OpenRouter).
// oauth-loopback: 고정 포트 localhost 콜백 (로컬 앱 전용 — 배포 불가).
export type SubscriptionKind = 'oauth-pkce' | 'oauth-code' | 'oauth-loopback' | 'device-code' | 'session-token';

export interface SubscriptionConfig {
  kind: SubscriptionKind;
  authorizeUrl?: string;  // oauth-pkce | oauth-code | oauth-loopback
  tokenUrl?: string;      // oauth-pkce | oauth-code | oauth-loopback | device-code
  clientId?: string;      // oauth-pkce | oauth-code | oauth-loopback | device-code
  scopes?: string[];      // oauth-pkce | oauth-code | oauth-loopback
  redirectUri?: string;   // oauth-code: authorize/exchange에 동일하게 쓰는 redirect
  loopbackPort?: number;  // oauth-loopback: 콜백을 받을 고정 포트(예: 1455)
  loopbackPath?: string;  // oauth-loopback: 콜백 경로(예: /auth/callback)
  extraAuthParams?: Record<string, string>; // 고정 authorize 파라미터(referrer, plan, originator 등)
  tokenHint?: string;     // session-token: 토큰 복사 위치 안내
  // device-code (OpenAI Codex) — P1_Reviewer 검증값
  issuer?: string;              // 예: https://auth.openai.com
  deviceUserCodeUrl?: string;   // 1회용 코드 발급
  deviceTokenUrl?: string;      // 승인 폴링
  verificationUrl?: string;     // 사용자가 코드를 승인하는 페이지
  steps?: string[];             // 사용자 안내 단계
  // 구독(subscription) 인증 시 apiKey 경로와 다른 엔드포인트를 쓰는 경우의 오버라이드.
  apiShape?: ApiShape;    // 예: OpenAI 구독은 chatgpt-codex 백엔드 사용
  baseUrl?: string;       // 예: https://chatgpt.com/backend-api/codex
}

export interface ProviderDef {
  id: string;
  label: string;
  apiShape: ApiShape;
  baseUrl: string;
  auth: AuthMethod[];
  subscription?: SubscriptionConfig;
  docsUrl?: string;
  // 자격증명 없이도 모델 목록(/models)을 조회할 수 있는 공개 엔드포인트 보유 여부.
  // 목록만 키 없이 가능하며, 실제 추론(chat)에는 무료 모델도 키가 필요하다.
  publicModelList?: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  created?: number;         // 출시/등록 시각(Unix sec) — 최신순 정렬
  promptPrice?: number;     // 입력 토큰당 단가(USD) — 가격순 정렬
  completionPrice?: number; // 출력 토큰당 단가(USD) — 비용 추정용
  contextLength?: number;   // 최대 컨텍스트 길이 — 컨텍스트순 정렬
  isFree?: boolean;         // 무료 모델 여부 — 무료 우선 정렬
}

export interface ProviderStatus {
  id: string;
  connected: boolean;
  method?: AuthMethod;
}
