# 트러블리포트 — 브라우저 확장 전환 & 네이버 매물 수집 (로그인·403·429)

> 작성: 2026-07-03 · 브랜치 `feat/browser-extension` · 대상: 매물시세(네이버) 탭
> 관련 문서: [`PLAN_browser_extension.md`](./PLAN_browser_extension.md), [`CASE_STUDY_naver_bearer_token.md`](./CASE_STUDY_naver_bearer_token.md), [`PLAN_hybrid_local_agent.md`](./PLAN_hybrid_local_agent.md)

---

## 0. 한 줄 요약

"네이버 로그인 필수 + 전용 프로그램(Electron 84MB) 설치 필수"라는 두 전제는 **둘 다 과했다.**
실제로는 (1) 로그인은 rate-limit 완화용 **선택**이었고, (2) 필요한 건 프로그램이 아니라 **주거 IP 중계기**(→ 브라우저 확장으로 충분)였다.
마지막까지 빌라·단독을 막던 진짜 벽은 로그인·설치와 무관한 **`403 Invalid referrer`**(forbidden header 문제)였고, `declarativeNetRequest`로 해결했다.

---

## 1. 배경 — 왜 중계기가 필요한가 (이건 사실)

네이버 부동산 API는 두 가지 이유로 브라우저에서 직접 못 부른다:

1. **CORS 미개방** — 네이버 API는 제3자 origin에 `Access-Control-Allow-Origin`을 안 준다. → 브라우저 직접 호출 불가, 프록시 필요.
2. **데이터센터 IP 차단** — Vercel 등 클라우드 IP는 네이버가 TCP 레벨에서 끊는다(`ECONNRESET`). → 서버 프록시 불가.

남는 길은 **사용자 주거 IP에서 중계**뿐이다. 여기까지는 맞았다. 문제는 "그 중계기를 무엇으로 만드느냐"와 "로그인이 정말 필요한가"였다.

---

## 2. 세 개의 근본 원인

증상은 "설치했는데 안 됨 / 로그인 반복해도 안 됨 / 빌라·단독만 계속 0건"이었다. 원인은 서로 다른 층에 3개가 겹쳐 있었다.

### 원인 ① 로그인을 "필수"로 오해 — 실은 rate-limit 완화용

| 구분 | 내용 |
|---|---|
| **잘못된 전제** | 네이버 매물 검색에 로그인 쿠키(NID_AUT/NID_SES)가 반드시 필요하다. |
| **실제** | 로그인 없이도 검색된다. 과거 VBA 크롤링이 로그인 없이 됐던 것과 동일. |
| **결정적 증거** | 쿠키 없는 요청의 응답이 **`401 Unauthorized`가 아니라 `429 TOO_MANY_REQUESTS`**. 401이면 "인증 필요", 429는 "요청 과다/봇 의심". 즉 로그인은 **인증 게이트가 아니라 rate-limit·봇차단 완화 요소**. |
| **왜 오해했나** | 로그인 세션이 있으면 429가 덜 떠서 "안정적"인데, 그걸 "필수"로 과하게 잡았다. |
| **부작용(2차 버그)** | `/validate`가 네이버 **429를 `valid:false`로** 반환 → 앱이 "쿠키 만료, 재로그인" 안내 후 검색 **차단**. 그런데 429는 재로그인으로 안 풀림 → **로그아웃·로그인을 반복해도 계속 막히는** 그 증상. |
| **수정** | `validateConnection`이 401/403(=`expired`)과 429(=`rate-limited`)를 구분. 429는 검색을 막지 않고 "잠시 후 자동 재시도"만 안내. 강제 로그인 화면 제거, 로그인은 선택 배너로. |
| **파일** | `src/services/agentApi.ts`(`ValidateResult`), `src/hooks/useAgentStatus.ts`(`connectionReason`), `src/components/NaverCrawlerTab.tsx`(`handleStart`), `src/services/crawler.ts`(429 로그 문구) |

### 원인 ② 빌라·단독 Bearer 미캡처 — MV3 `webRequest`에 `extraHeaders` 누락

| 구분 | 내용 |
|---|---|
| **배경** | 아파트는 `fin.land`(쿠키만) 경로라 됐지만, **빌라·단독은 `new.land /api/articles` 경로뿐이고 이건 Authorization Bearer JWT 필수**. 이 Bearer는 로그인 자격증명이 아니라 네이버 프론트가 발급하는 ~3시간짜리 익명 토큰(`id:REALESTATE`). 로그인해도 저절로 안 생긴다. |
| **로컬은 왜 됐나** | dev 서버는 puppeteer(`server/naverTokenProvider.mjs`)로 `new.land/houses`를 실제 구동해 그 토큰을 헤더에서 가로챘다. |
| **확장은 왜 실패** | 같은 캡처를 `chrome.webRequest.onBeforeSendHeaders`로 하는데, **extraInfoSpec에 `extraHeaders`가 없으면 최신 크롬에서 `Authorization` 헤더가 리스너에 안 보인다.** → 토큰 못 잡음 → 빌라·단독 조용히 401 → 0건. |
| **수정** | 리스너에 `['requestHeaders', 'extraHeaders']` 지정. 더해서: new.land를 지도 좌표 붙인 URL로 백그라운드 탭에서 열어 `/api` 호출 유발, 동시 캡처 중복 방지, JWT `exp` 검사, 401 시 강제 재캡처 1회 자가치유. |
| **파일** | `extension/background.js` |

### 원인 ③ `403 Invalid referrer` — `Referer`는 forbidden header라 fetch로 못 넣음

| 구분 | 내용 |
|---|---|
| **증상** | Bearer는 붙었는데(`hasBearer=true`) `/api/articles`가 **`403 Invalid referrer`**. |
| **실제 원인** | `Referer`·`Origin`·`User-Agent`·`Sec-Fetch-*`·`Accept-Language`는 브라우저의 **forbidden headers**. 스크립트(확장 포함) `fetch()`가 값을 넣어도 **브라우저가 무시하고 자기 값(확장 origin)으로** 보낸다. new.land `/api/articles`는 Referer를 검사하므로 거부. |
| **왜 아파트는 됐나** | fin.land 엔드포인트는 Referer를 검사하지 않는다. 그래서 같은 코드로도 아파트만 통과했다. |
| **수정** | fetch로 못 넣으니 **`declarativeNetRequest` 정적 규칙(`rules.json`)으로 네트워크 계층에서 Referer/Origin 주입.** DNR은 forbidden header도 설정 가능. |
| **파일** | `extension/rules.json`, `extension/manifest.json`(`declarativeNetRequestWithHostAccess` 권한 + 규칙 등록) |
| **검증** | 콘솔 로그가 `→ 403 ... Invalid referrer` 에서 `→ 200 ... {"articleList":[...` 로 전환. 빌라(VL)·단독/다가구(DDDGG) 모두 정상. |

---

## 3. "왜 로그인 버튼 없이도 되나" — 로그인의 새 위치

- **강제 로그인 화면은 제거**됐다. 확장만 설치되면 로그인 여부와 무관하게 **바로 검색 화면**으로 진입한다.
- 로그인은 사라진 게 아니라 **선택**으로 내려갔다: 검색 화면 상단에 닫을 수 있는 안내 배너
  ("네이버 로그인 없이도 검색됩니다. 자주 막히거나 빌라·단독 결과가 비면 로그인 권장")와 그 안의 **`네이버 로그인` 버튼**이 있다.
- 쿠키 처리도 바뀌었다: 확장 백그라운드 fetch가 `credentials: 'include'`로 **브라우저의 (익명이든 로그인이든) 네이버 쿠키를 자동 포함**한다. 앱이 쿠키를 직접 저장·주입할 필요가 없어졌다(구 Electron의 쿠키 캡처 로그인 창 제거).

정리: 로그인은 "없어도 되는 것"이 됐고, 필요할 때만 누르는 버튼으로 남았다.

---

## 4. 디버깅이 어떻게 좁혀졌나 (순서)

1. **429 vs 401 구분**으로 "로그인 필수" 전제를 깼다 → 로그인 선택화.
2. 로그인 없이도 아파트는 됐지만 **빌라·단독만 0건** → `/api/articles`의 Bearer 의존을 지목.
3. 확장에 **진단 로그**(`[Estate-OS] <base> <path> → <status> | hasBearer=? | <body앞부분>`)를 심어 실제 응답을 확인.
4. 로그가 `403 | hasBearer=true | Invalid referrer`를 찍음 → Bearer가 아니라 **Referer**가 원인임이 확정.
5. forbidden header 성질을 근거로 `declarativeNetRequest`로 Referer 주입 → `200 + articleList` 확인.
6. 진단 로그는 오류(비2xx)일 때만 남기도록 정리(데이터 노출·소음 방지).

> 교훈: "안 된다"의 상태코드를 **정확히 읽는 것**(401 vs 403 vs 429)이 절반이었다. 셋 다 원인이 완전히 달랐다.

---

## 5. 최종 아키텍처 (요약)

```
estate-os.vercel.app (웹앱)
   │ postMessage RPC (extensionBridge.ts)
   ▼
content-bridge.js (확장 content script)
   │ chrome.runtime.sendMessage
   ▼
background.js (확장 service worker)
   ├─ fetch: 주거 IP + 브라우저 네이버 쿠키 자동(credentials:include)
   ├─ webRequest(extraHeaders): new.land Bearer 캡처 → storage.session
   └─ declarativeNetRequest(rules.json): Referer/Origin 주입
   ▼
네이버 fin.land(아파트, 쿠키) / new.land(단지·빌라·단독, Bearer+Referer)
```

- 확장 없으면 `naverApi.ts`가 dev 프록시(`/naver-api`)로 폴백 → 로컬 개발 유지.

---

## 6. 재발 방지 체크리스트 / 교훈

- [ ] 네이버가 "안 준다"고 단정 전에 **상태코드 확인**: `401`=인증, `403`=권한/헤더검증, `429`=rate limit. 대응이 전혀 다르다.
- [ ] 429를 인증 실패로 처리해 재로그인을 강요하지 말 것(무한 삽질 유발).
- [ ] 확장에서 `Authorization`을 `webRequest`로 읽으려면 **`extraHeaders` 필수**.
- [ ] 확장/스크립트 `fetch`로 `Referer`·`Origin`·`User-Agent`·`Sec-Fetch-*`·`Accept-Language`는 **설정 불가(무시됨)**. 서버가 이 헤더를 검사하면 **`declarativeNetRequest`** 로 주입.
- [ ] new.land Bearer는 로그인 토큰이 아니라 **익명·~3시간짜리**. 만료(`exp`) 검사 + 401 자가치유 필요.
- [ ] 빌라·단독 = `new.land /api/articles` 단일 경로 → Bearer+Referer 둘 다 있어야 동작.

---

## 7. 남은 작업

- [ ] `extension/`을 크롬/엣지 웹스토어에 게시 → 확장 ID 확정.
- [ ] `src/services/agentApi.ts`의 `EXTENSION_STORE_URL`을 실제 상세페이지 URL로 교체.
- [ ] 확장 게시 완료 **후** `feat/browser-extension` → `main` 머지(현재 main=production, 그 전 머지 시 기존 Electron 에이전트 사용자가 끊김).
- [ ] 안정화 후 구 Electron `agent/` 및 Vercel `api/naver-*` 프록시 정리.
