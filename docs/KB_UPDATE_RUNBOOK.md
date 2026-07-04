# KB 시계열 데이터 갱신 런북

주간(매주 금요일 발표)·월간(매월 말 발표) KB 시계열을 앱에 반영하는 절차.
데이터 구조 배경은 `docs/KB_TIMESERIES_DATA_REPORT.md` 참고.

## ⚡ 완전 자동 (기본 — GitHub Actions, PC 불필요)

`.github/workflows/kb-data-update.yml` 이 **매일 10:30 KST**에 깃허브 클라우드에서 실행된다:

1. KB 통계 API로 최신 주간/월간 시계열 확인 (상태: `public/data/.kb-state.json`, 커밋됨)
2. 새 파일이면 다운로드 → 인제스트 → **public/data 자동 커밋** → Vercel 자동 재배포(정적 모드 반영)
3. GitHub Secrets(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)가 등록돼 있으면 Supabase 발행까지
   (미등록이어도 커밋 경로는 정상 — supabase 모드를 쓸 때만 필요)
4. 같은 파일이면 아무것도 안 함(멱등)

수동 실행: GitHub 저장소 → Actions 탭 → "KB 시계열 자동 갱신" → **Run workflow**.
실행 이력·로그도 같은 화면에서 확인.

**어떤 PC도 켜져 있을 필요가 없고, 로컬 작업 폴더를 지워도 갱신은 계속된다.**
로컬에서 즉시 갱신하고 싶을 때만 아래 로컬 방식을 쓰면 된다.

## 로컬 실행 (선택 — 즉시 갱신·오프라인 검증용)

같은 스크립트를 로컬에서 돌릴 수 있다. Windows 작업 스케줄러 등록(선택):
`schtasks /Create /TN "KB-Timeseries-AutoUpdate" /TR "C:\dev\r0_naver-kb\scripts\kb-update.cmd" /SC DAILY /ST 10:30 /F`
— GitHub Actions가 기본이므로 보통 불필요. 스크립트는:

1. KB 통계 API(`api.kbland.kr/land-extra/statistics/reference`, 인증 불필요)로 최신
   주간/월간 시계열 파일명을 확인
2. 새 파일이면 `getfiledown` 엔드포인트로 다운로드(`data-src/`, git 미추적)
3. `kb-ingest.mjs` 로 public/data/*.json 재생성 (diff·무결성 검증 포함)
4. `.env.kb-publish` 가 있으면 Supabase 발행까지
5. 같은 파일이면 아무것도 안 함(멱등) — 로그: `logs/kb-update.log`

```powershell
# 수동 실행/점검
node scripts/kb-update.mjs            # 확인+다운로드+인제스트
node scripts/kb-update.mjs --check    # 새 파일 여부만 (exit 2 = 갱신 있음)
node scripts/kb-update.mjs --force    # 강제 재다운로드
schtasks /Query /TN "KB-Timeseries-AutoUpdate" /FO LIST   # 스케줄 상태
```

**배포(Supabase)까지 자동으로 하려면** 프로젝트 루트에 `.env.kb-publish` 생성(git 미추적):

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
```

없으면 로컬 public/data 만 갱신되고 발행은 건너뛴다(로그에 표시).
`public/data` 변경분의 git 커밋은 자동화하지 않는다 — 확인 후 직접 커밋.

주의: PC가 꺼져 있으면 그 날 실행은 건너뛴다(다음 날 따라잡음). 헤더의 신선도
뱃지(⚠)가 지연 감지 백업 역할을 한다. KB가 API 구조를 바꾸면 스크립트가 명확한
에러로 중단되니 로그를 확인할 것.

## 수동 절차 (자동화 실패 시 폴백)

### 1. 엑셀 다운로드

KB부동산 통계 페이지에서 최신 파일 2개(주간은 매주, 월간은 매월 새 파일)를 받는다:

- https://kbland.kr/webview.html#/main/statistics?channel=kbland&tab=0
- 파일명 규칙: `YYYYMMDD_주간시계열.xlsx` / `YYYYMM_월간 주택 시계열.xlsx`
- 월간 파일이 그대로면 `--monthly`에 기존 파일을 넣어도 된다(주간만 갱신).

### 2. 인제스트 (엑셀 → public/data/*.json)

```powershell
# 미리보기(파일 쓰기 없음) — diff 리포트만 확인
node scripts/kb-ingest.mjs --weekly "C:\Users\Space\Downloads\20260706_주간시계열.xlsx" --monthly "C:\Users\Space\Downloads\202606_월간 주택 시계열.xlsx" --dry

# 실제 반영
node scripts/kb-ingest.mjs --weekly "..." --monthly "..."
```

**diff 리포트 읽는 법** — 정상 갱신이라면:
- `+ 시점 추가`: 주간 1개(새 주) / 월간 0~1개(새 달)
- `값 비교 … 상이 0건` — 상이 건수가 있으면 KB가 과거치를 정정한 것(소수 건은 정상,
  대량이면 원본 파일·시트 구조 변화 의심)
- `지역 추가/제거`가 떴다면 행정구역 개편 반영(예: 인천 제물포·영종·서해·검단구,
  전남광주통합특별시에 첫 데이터 유입) — 보고서 §2 자리표시자 목록과 대조

스크립트가 **에러로 중단**되면(날짜축 역행, 필수 지역 누락, 유령 키 감지) KB가 시트 구조를
바꾼 것이다. `scripts/kb-ingest.mjs`의 시트 파서와 `scripts/kb-regions.mjs` 정규화 테이블을 점검.

### 3. 커밋 + 배포

```powershell
git add public/data
git commit -m "data: KB 시계열 갱신 (주간 YYYY-MM-DD / 월간 YYYY-MM)"

# Supabase Storage 발행 (VITE_KB_DATA_SOURCE=supabase 배포용)
$env:SUPABASE_URL = "https://<project>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service_role key — 절대 커밋 금지>"
node scripts/kb-publish-bundles.mjs
```

발행되면 클라이언트는 다음 로드 때 versions.json 해시 비교로 **바뀐 번들만** 자동 다운로드한다
(IndexedDB 캐시). 정적 소스(`static`) 배포라면 public/data 커밋 + 재배포만으로 반영된다.

## 자동화 메모

- ~~KB 사이트 다운로드 자동화는 로그인·약관 문제로 보류~~ → **2026-07 완전 자동화됨.**
  조사 결과 통계 API·파일 다운로드 모두 인증 불필요(Referer만)로 확인.
  API: `GET /land-extra/statistics/reference?주월간구분={0|1}&기준년월시작일=…&기준년월종료일=…`
  다운로드: `GET /land-extra/statistics/getfiledown?urlpath={파일경로}/{파일명}&filename={원본파일명}`
- 인제스트는 결정적(같은 입력 → 같은 출력)이므로 같은 파일로 재실행해도 안전하다.

## 알려진 원본 데이터 특성 (버그 아님)

- 주간 `2.전세증감` 시트 헤더에 `강원특별자치도도` 오타 → `kb-regions.mjs` CANON이 흡수.
- 월간 `23.전세수급`만 지수 열 위치가 다름(3번째, 나머지 심리 시트는 마지막) → 파서에 반영됨.
- 월간 파일은 구명칭(전라북도 등)·시 접미사 누락(의왕 등)을 쓴다 → 신명칭으로 정규화됨.
- 빈 자리표시자 열(2026 행정개편 지역)은 값이 생길 때까지 산출물에서 자동 제외된다.
