# KB 시계열 데이터 갱신 런북

주간(매주 금요일 발표)·월간(매월 말 발표) KB 시계열을 앱에 반영하는 절차.
전체 소요: 약 5분. 데이터 구조 배경은 `docs/KB_TIMESERIES_DATA_REPORT.md` 참고.

## 절차

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

- KB 사이트 다운로드 자동화는 로그인·약관 문제로 보류(수동 유지). 대신 앱에 데이터
  기준일 표시를 붙여 갱신 누락을 눈에 띄게 만드는 것이 P2 과제로 계획돼 있음
  (`docs/PROMPT_kb_analysis_upgrade.md` P2-3).
- 인제스트는 결정적(같은 입력 → 같은 출력)이므로 같은 파일로 재실행해도 안전하다.

## 알려진 원본 데이터 특성 (버그 아님)

- 주간 `2.전세증감` 시트 헤더에 `강원특별자치도도` 오타 → `kb-regions.mjs` CANON이 흡수.
- 월간 `23.전세수급`만 지수 열 위치가 다름(3번째, 나머지 심리 시트는 마지막) → 파서에 반영됨.
- 월간 파일은 구명칭(전라북도 등)·시 접미사 누락(의왕 등)을 쓴다 → 신명칭으로 정규화됨.
- 빈 자리표시자 열(2026 행정개편 지역)은 값이 생길 때까지 산출물에서 자동 제외된다.
