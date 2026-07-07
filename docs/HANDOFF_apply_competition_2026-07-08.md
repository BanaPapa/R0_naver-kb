# 인계 문서 — 청약(Apply) 경쟁률 데이터 (2026-07-08)

다음 대화 세션이 이 문서만 읽고 바로 이어서 작업할 수 있도록 정리한 핸드오프.
맨 아래 **"다음 세션 시작 프롬프트"**를 복붙하면 됩니다.

---

## 1. 환경 좌표

| 항목 | 값 |
|---|---|
| 배포 URL | https://estate-os.vercel.app |
| Vercel 프로젝트 | `banas-projects/estate-os` (CLI 인증 계정 `polateria-7389`) |
| Supabase 프로젝트 | `lnvpfomcrbcxjwjqkiqu` (naver-kb와 공유 인스턴스, `apply_*` 테이블) |
| 로컬 시크릿 | `.env.kb-publish` (gitignore됨): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ODCLOUD_SERVICE_KEY` |
| 관련 코드 | `lib/applyhome/{handlers,archive,historical,odcloud}.mjs`, `scripts/apply-archive-sync.mjs` |
| 원본 앱(참고) | `C:/dev/R6_Apply` — 같은 Supabase에 직접 적재. 별도 데이터 저장소 없음 |
| API 기술문서 | `C:/Users/Space/Downloads/기술문서_청약홈 청약접수 경쟁률...pdf`(경쟁률), `..._분양정보...pdf` |

---

## 2. 이번 세션에 완료된 것

**pre-2020 검색(목록) 버그 수정 — 배포 검증 완료.**
- 증상: 배포 버전에서 2020년 이전 청약 검색이 0건.
- 근본 원인: Vercel Production에 `SUPABASE_SERVICE_ROLE_KEY` 미설정 → 서버
  `getSupabaseAdmin()`=null → 아카이브 우선 조회가 null 폴백 → 라이브 크롤(0건) → 빈 결과.
- 조치: `vercel env add SUPABASE_SERVICE_ROLE_KEY production` + redeploy.
- 검증: `/api/apartments/search?startDate=201801&endDate=201812` → 108건, `source: "archive"`.
- **코드 변경 아님(순수 배포 env 누락).**

---

## 3. 확정된 사실 (⛔ 재조사 금지 — 데이터셋 전량 조회로 증명 완료)

**pre-2020(2014~2019) 경쟁률은 원천 자체가 존재하지 않음.**

아카이브 연도별 현황:

| 연도 | 공고(목록·단지명·지역·세대수·공고일) | 경쟁률 |
|---|---|---|
| 2014 | 6 | 0 |
| 2015 | 56 | 0 |
| 2016 | 98 | 0 |
| 2017 | 80 | 0 |
| 2018 | 108 | 0 |
| 2019 | 55 | 0 |
| **합계** | **403** | **0** |

- 공공데이터포털 청약홈 API **2개 서비스 모두 2020-02부터** 시작 (청약홈이 2020-02 한국부동산원
  이관 때 개설). 경쟁률 서비스 `ApplyhomeInfoCmpetRtSvc` 8개 오퍼레이션 전량을 연도로 조회 →
  2017/2018/2019 = 0건. 분양정보 서비스 `ApplyhomeInfoDetailSvc`도 동일.
- 원본 `C:/dev/R6_Apply/scripts/backfill.mjs` 주석이 명시: *"2015~2020-01 : 청약홈 detail
  페이지 직접 스캔 — 공급정보만(경쟁률은 어디에도 없음)"*. 우리 아카이브 pre-2020 행이
  `source: "applyhome-detail"`, `detail.competition.rows: []`, summary null 로 정확히 일치.
- **결론: pre-2020은 목록·공고정보까지만 제공, 경쟁률은 "-" 가 정상. 복구 경로 없음.**

---

## 4. 남은 작업 (다음 세션 목표) — 2020+ 임대·잔여세대 경쟁률 보강

**문제:** 현재/원본 백필 모두 APT 경쟁률 오퍼레이션(`getAPTLttotPblancCmpet`)만 사용.
그래서 2020년 이후 **임대·잔여세대·도시형** 단지는 경쟁률이 미적재되어 UI에서 "-"로 표시됨.
(2020+ `average_competition_rate IS NULL` 후보 ≈ 417건. 이 중 다수는 국민임대/행복주택처럼
경쟁률이 원래 없는 배정형이라 최종 채워지는 건 일부.)

**해결 방향:** `lib/applyhome/odcloud.mjs`에 유형별 경쟁률 조회를 추가하고, houseManageNo로
아래 오퍼레이션들을 순차 시도하여 데이터가 있으면 summary + `detail.competition/specialSupply`를
채운다. (모두 서비스 base = `ApplyhomeInfoCmpetRtSvc`, 2020+ 커버)

| 오퍼레이션 | 유형 | 2020 보유 |
|---|---|---|
| `getRemndrLttotPblancCmpet` | 잔여세대 | 208 |
| `getUrbtyOfctlLttotPblancCmpet` | 도시형·공공임대·생활숙박 | 417 |
| `getPblPvtRentLttotPblancCmpet` | 공공지원 민간임대 | 376 |
| (`getOPTLttotPblancCmpet` 임의공급 / `getCancResplLttotPblancCmpet` 취소후재공급은 2020 0건) | | |

**주의:**
1. 응답 필드 스키마가 APT(`getAPTLttotPblancCmpet`)와 다를 수 있음 → 유형별로 `summarizeCompetition`/
   `buildCompetitionGrid` 매핑 재검토 필요(주택형/순위/지역 컬럼명 확인).
2. 우리 아카이브의 `house_manage_no`가 각 유형 오퍼레이션에서 매칭되는지 **표본 몇 건으로 먼저 검증**
   후 전량 실행 (APT는 매칭됐지만 유형별은 미확인).
3. 공공데이터포털 **일일 트래픽 한도** 있음 — 동시성 낮게(1~2), sleep 넉넉히. 이번 세션에 APT
   백필 돌릴 때 트래픽 초과 경험함.
4. 실행: `node --env-file=.env.kb-publish scripts/<script>.mjs` (ODCLOUD_SERVICE_KEY는 이미 파일에 있음).
5. 백필 후 스냅샷은 "오늘" 날짜로 찍지 말 것(시계열 왜곡). master 행만 채우거나 공고일 기준으로.

**선택(별개):** 2018-2019 경쟁률은 §3대로 복구 불가. 사용자가 외부(다른 소스)에서 원본을
확보해오면 임포트만 하면 됨. 그 전엔 목록만 유지.

---

## 5. 유용한 명령

```bash
# Vercel prod env 이름 확인 (값은 Sensitive라 안 읽힘)
vercel env ls production        # cwd: C:/dev/R0_naver-kb (linked)

# 아카이브 상태 조회 예시
node --env-file=.env.kb-publish -e '<supabase-js 쿼리>'

# 배포 재적용(env 변경 후)
vercel redeploy <latest-prod-url>
```

---

## 6. 다음 세션 시작 프롬프트 (복붙용)

```
청약(Apply) 탭의 2020년 이후 임대·잔여세대 경쟁률을 보강하고 싶어.
docs/HANDOFF_apply_competition_2026-07-08.md 를 먼저 읽고, §4 "남은 작업"을 진행해줘.
- 먼저 유형별 오퍼레이션(getRemndr/getUrbty/getPblPvtRent)이 우리 아카이브 house_manage_no로
  매칭되는지 표본 3~5건으로 검증하고, 응답 필드 스키마를 확인해줘.
- 매칭·스키마가 맞으면 lib/applyhome/odcloud.mjs 에 유형별 경쟁률 조회를 추가하고,
  2020+ average_competition_rate IS NULL 행을 백필하는 스크립트를 만들어 실행해줘.
- 트래픽 한도 주의(동시성 낮게), 스냅샷 날짜 왜곡 주의.
ODCLOUD_SERVICE_KEY는 .env.kb-publish 에 이미 있어. pre-2020(2014~2019) 경쟁률은 원천이
없어서 손대지 않아도 돼(문서 §3 참고).
```
