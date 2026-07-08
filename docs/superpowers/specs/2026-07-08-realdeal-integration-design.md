# 실거래가(실거래 다운로드) 모듈 통합 설계

/ R4_Real(실거래 다운로드 단일 앱)을 통합 호스트 `R0_naver-kb`의 사이드바 **실거래가** 탭으로 병합한다. /

## 배경 / 결정

- **호스트** = `R0_naver-kb` (React 19 / Vite 7 / Tailwind[preflight off] / Supabase 로그인 게이트 / Vercel).
  이미 KB시계열·KB시세·매물시세·지역별청약현황이 통합되어 라이브.
- **소스** = `C:\dev\r4_real` (R4_Real). React 19 / Vite 6 / Vanilla CSS / 국토부 실거래(data.go.kr).
- 선례: KB시세(`src/kbprice`)·청약(`src/apply`)이 **네임스페이스 이식 + 지연 마운트 + display 토글**로 통합됨. KB시계열은 `.kb-scope`로 CSS 전면 격리. **실거래가도 동일 패턴을 답습**한다.
- 사이드바에는 이미 `real-deal` 모듈이 `status:'soon'`(비활성)으로 자리만 잡혀 있음 → 활성화한다.
- **API 키(공공데이터포털 serviceKey)**: 소유자의 단일 키(1일 1,000회)를 **서버사이드에서만 주입**(클라이언트 번들 노출 금지). `MOLIT_API_KEY`(VITE_ 접두사 없음) 환경변수 → dev Vite 미들웨어 + Vercel 서버리스 함수가 주입. 클라이언트는 키를 모른 채 `/molit-api` 호출.
- 작업 위치: `C:\dev\R0_naver-kb` 브랜치 `feat/realdeal-integration`. typecheck/build 검증 후 사용자 리뷰 → push.

## 핵심 난제와 해법

### 1. CSS 충돌 (최대 리스크)
소스 `index.css`(2256줄)는 호스트와 **동일한 `eos-*` 셸 클래스**(`eos-app/main/hdr/work/ctrl/view/kpi/card`)와 **동일한 제네릭 클래스**(`form-select`, `region-select`, `result-table`, `status-badge`, `btn-outline`, `modal-overlay`, `select-wrapper` 등)를 사용하고, `:root`에 동명의 CSS 변수(`--bg`, `--teal`, `--muted`…)를 정의한다. 그대로 두면 호스트 테마·레이아웃이 오염된다.

**해법 — 3중 격리로 `src/realdeal/realdeal.css` 생성 (스크립트 변환):**
1. `eos-` → `rd-` 전역 치환 (CSS + TSX 동기) → 호스트의 복합 `.eos-*` 선택자가 모듈 요소에 매칭되지 않음.
2. 모든 최상위 선택자에 `.rd-scope ` 접두 (콤마 목록·`@media` 재귀 처리, `@keyframes` 스텝 제외).
3. `:root` → `.rd-scope` 로 치환 (CSS 변수를 스코프에 가둠, `html/body/*` 전역 리셋도 스코프화).
4. 생성물 최상단에 `.rd-scope { display: contents; }` 수동 추가 (래퍼가 호스트 `.eos-main` 레이아웃에 그대로 흘러들어가도록; 커스텀 속성 상속 유지).

### 2. 백엔드 키 주입 (dev + prod)
- 클라이언트(`transactionService`)는 `serviceKey` 없이 `/molit-api/<data.go.kr 경로>?LAWD_CD=…&DEAL_YMD=…` 호출.
- **dev**: 호스트 `vite.config.ts`에 `/molit-api` 프록시 추가 — `configure`에서 `proxyReq.path`에 `serviceKey=<MOLIT_API_KEY>` 주입(loadEnv로 서버측 키 읽기), target `https://apis.data.go.kr`.
- **prod**: 서버리스 `api/molit-proxy.ts` — `process.env.MOLIT_API_KEY` 주입 후 data.go.kr에 fetch, XML 원문 반환. `vercel.json`에 rewrite `{"source":"/molit-api/(.*)","destination":"/api/molit-proxy?__path=$1"}`.
- 소스의 공용 CORS 폴백(corsproxy.io 등)은 키 노출 위험 → **제거**. 5xx/타임아웃 시 `transient` 재시도 로직은 유지.

## 이식 산출물 (`src/realdeal/`)

| 파일 | 처리 |
|------|------|
| `RealDealTab.tsx` | 소스 `App.tsx`에서 사이드바·`eos-app` 셸·탭 분기·SettingsModal·폰트/키 상태 제거. 실거래 UI + AnalysisModal + 서버장애 모달만 유지. `eos-`→`rd-` 리네임. `<div className="rd-scope">` 래핑. props `userId`(서명 통일, 현재 미사용) 없이 무인자. |
| `AnalysisModal.tsx` | 순수 Tailwind → 그대로 이식(충돌 없음). |
| `SpaceRangeSlider.tsx` | 그대로 이식. |
| `services/api.ts` | KB Land 지역 로딩(CORS-OK) 유지. `validateGovApiKey`/`fetchWithProxy` 사용처(SettingsModal) 제거로 함께 삭제. |
| `services/transactionService.ts` | 키 파라미터 제거, `/molit-api` 경로 호출(단일 후보), 프록시 키 주입 전제. |
| `types.ts` | 그대로 이식. |
| `realdeal.css` | 위 3중 격리 스크립트 산출물. |

**스코프 축소 결정(YAGNI)**: SettingsModal(면적 프리셋 편집·폰트 설정)은 v1에서 **미이식**. 면적 프리셋은 기본값(`INITIAL_TRANS_APT/OPST_OPTIONS`)으로 동작(프리셋 드롭다운 정상). 폰트는 호스트가 전역(Pretendard) 관리. API 키 UI는 서버 주입으로 불필요. → Tailwind-모달 이식/키검증/기어버튼 배선 제거로 리스크↓. 추후 필요 시 면적 편집만 소형 모달로 재도입 가능.

## 배선 (호스트 3파일)

1. `src/components/Sidebar.tsx`: `AppTab`에 `'realdeal'` 추가. `real-deal` 모듈 → `tab:'realdeal'`, `status:'live'`.
2. `src/App.tsx`: `isRealdeal` 분기 + 지연 마운트(`realdealSeen`) + display 토글. 호스트 헤더 숨김 조건에 `!isRealdeal` 추가(자체 헤더 렌더 — KB와 동일). `import { RealDealTab } from './realdeal/RealDealTab'`.
3. `vite.config.ts` + `vercel.json` + `api/molit-proxy.ts` + `.env.example`(MOLIT_API_KEY): 백엔드 키 주입.

## 검증
- `npm run typecheck` + `npm run build` 통과.
- dev 서버에서 실거래가 탭: 지역 캐스케이드 로딩 → 수집 실행 → 결과 테이블/CSV/JSON/분석, 매물시세·KB 등 타 탭 무손상, 다크테마 무오염 수동 확인.
- `MOLIT_API_KEY` 미설정 시 명확한 오류 안내(키 없음 ≠ 서버 장애).
