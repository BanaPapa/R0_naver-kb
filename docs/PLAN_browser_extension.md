# Estate-OS — 브라우저 확장 전환 개발문서

> 작성 시점: 2026-07-03. 이전 문서 `PLAN_hybrid_local_agent.md`(Electron 에이전트)를 대체하는 방향 결정.

## 0. 한 줄 요약

네이버가 데이터센터 IP를 차단(ECONNRESET)하므로 **사용자 주거 IP에서 네이버를 호출하는 중계기**가 필요하다.
지금까지는 그 중계기를 84MB Electron 트레이앱(다운로드 설치)으로 만들었으나, **설치 마찰(SmartScreen·용량)** 과
**로그인 캡처 UX 불안정**이 컸다. → **브라우저 확장(Manifest V3, 크롬/엣지 웹스토어 배포)** 으로 전환한다.

## 1. 왜 확장이 더 나은가 (검증된 근거)

- **CORS 우회**: 확장 백그라운드(service worker)는 `host_permissions`에 선언된 네이버 도메인을 CORS 제약 없이 직접 호출할 수 있다. 페이지 fetch와 달리 CORS 프리플라이트/차단 대상이 아니다.
- **주거 IP**: 확장은 사용자의 브라우저에서 실행 → 사용자 집 IP로 네이버에 나간다. 데이터센터 차단 회피.
- **브라우저 쿠키 재사용**: 사용자가 브라우저에서 평소처럼 네이버에 로그인해 두면, 확장 백그라운드 fetch가 그 네이버 세션 쿠키를 자동으로 실어 보낸다(host_permissions 보유 시). → Electron의 "쿠키 캡처 로그인 창"이 통째로 불필요.
- **설치 마찰 최소**: 크롬 웹스토어 "Chrome에 추가" 한 번. exe·SmartScreen·84MB 없음.

## 2. 아키텍처

```
estate-os.vercel.app (웹앱)
   │  window.postMessage RPC
   ▼
content-bridge.js  (확장 content script, 웹앱 페이지에 주입)
   │  chrome.runtime.sendMessage
   ▼
background.js  (확장 service worker)
   │  fetch (host_permissions → 주거 IP + 브라우저 네이버 쿠키 자동)
   ▼
네이버 fin.land / new.land   ← 주거 IP라 차단 안 됨
```

- **쿠키/로그인(중요)**: 네이버 로그인은 **필수가 아니라 선택**이다. 네이버 매물 API는 로그인 없이도 동작한다(실패 시 `401`이 아니라 `429 TOO_MANY_REQUESTS`를 반환 — 인증 게이트가 아니라 rate limit/봇차단). 확장은 브라우저의 **익명 세션 쿠키**를 자동으로 실어 보내며, 사용자가 마침 네이버에 로그인되어 있으면 그 쿠키가 함께 쓰여 429/봇차단이 완화된다. 따라서 UI는 로그인을 강제하지 않고, "검색이 자주 막히면 로그인 권장" 수준으로만 안내한다.
- **Bearer(빌라·단독 `/api/articles` 전용)**: `chrome.webRequest.onBeforeSendHeaders`로 new.land 요청의 `Authorization`을 수동 캡처해 `chrome.storage.session`에 보관. 없으면 new.land 탭을 잠깐 열어 유발 후 캡처. **주의: `onBeforeSendHeaders` extraInfoSpec에 `extraHeaders`가 없으면 최신 크롬에서 Authorization 헤더가 안 보인다 → 반드시 포함.**
- **Referer/Origin(중요)**: `Referer`·`Origin`·`User-Agent`·`Sec-Fetch-*`·`Accept-Language`는 "forbidden headers"라 확장 `fetch()`로 설정해도 브라우저가 무시한다. new.land `/api/articles`는 Referer를 검사하므로(없으면 `403 Invalid referrer`), **`declarativeNetRequest` 정적 규칙(`rules.json`)으로 네트워크 계층에서 Referer/Origin을 강제 주입**한다. fin.land는 Referer 미검사라 규칙 없이도 동작하지만 일관성을 위해 함께 주입한다.
- **로그인 상태 감지**: `chrome.cookies`로 `NID_AUT`/`NID_SES` 존재 확인. 없으면 웹앱이 "네이버 로그인 필요" 안내 → 확장이 네이버 로그인 탭을 연다.
- **크롤 토큰(라이선스)**: 기존 그대로. 웹앱이 Vercel `/api/crawl-token`에서 발급받아 확장 호출 시 함께 전달(선택적 게이트).

## 3. 메시지 프로토콜 (웹앱 ↔ 확장)

| kind | 방향 | 설명 |
|---|---|---|
| `PING` | 웹앱→확장 | 확장 설치·활성 감지. `{ ok, version }` |
| `STATUS` | 웹앱→확장 | 네이버 로그인 상태. `{ loggedIn, hasBearer }` |
| `OPEN_LOGIN` | 웹앱→확장 | 네이버 로그인 탭 열기(쿠키 생길 때까지 대기) |
| `NAVER_FETCH` | 웹앱→확장 | 실제 네이버 API 중계. `{ base, path, method, query, body, referer }` → `{ status, body }` |

## 4. 웹앱 변경점

- `src/services/extensionBridge.ts` (신규): postMessage 기반 프로미스 RPC.
- `src/services/agentApi.ts`: HTTP(127.0.0.1:47328) 호출 → `extensionBridge` 호출로 교체. 함수 시그니처는 유지(hook 영향 최소화).
- `src/services/naverApi.ts`: 전송 계층을 URL fetch → 확장 메시지로 라우팅. 확장 없으면 기존 dev 프록시(`/naver-api`)로 폴백(로컬 개발 유지).

## 5. 반드시 함께 고치는 버그 (전송 방식과 무관)

**429(rate limit)를 인증 실패로 오해하는 버그.**
- 증상: 설치 후 로그인/로그아웃을 반복해도 검색이 계속 막힘.
- 원인 경로: `agent/src/server.ts`의 `/validate`가 네이버 429를 `valid:false`로 응답 → `validateConnection()`이 false 반환 → `useAgentStatus`가 `connectionValid=false` → `NaverCrawlerTab.handleStart`가 "재로그인하라"며 검색 차단.
- 문제: 429는 rate limit이지 쿠키 만료가 아니다. 재로그인으로 429는 안 풀린다.
- 수정: 401/403만 "재로그인 필요"로, 429는 "잠시 후 재시도"로 분리 안내. 확장 STATUS/검증 로직에도 동일 적용.

## 6. 배포

- **크롬/엣지 웹스토어 등록**(결정됨). 개발 중에는 unpacked로 로드해 검증, 이후 스토어 제출.
- 확장 ID 고정을 위해 `key`를 manifest에 박거나 스토어 등록 후 ID 확정. content script는 `estate-os.vercel.app` + localhost dev에 매칭.

## 7. 남는 결정 / TODO

- [ ] 웹스토어 개발자 계정($5) 준비 및 최초 심사 제출.
- [ ] 확장 ID 확정 후 웹앱의 감지 로직에 반영(필요 시).
- [ ] 빌라 Bearer 자동 유발(백그라운드 new.land 탭) UX 확정.
- [ ] 기존 Electron `agent/` 및 Vercel `api/naver-*` 프록시 정리 시점 결정(확장 안정화 후).
