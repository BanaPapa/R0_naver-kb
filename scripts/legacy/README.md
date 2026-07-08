# 레거시 분양 통계 적재 (2000~2026)

청약홈은 공고 목록을 **약 5년만** 노출하고, 5년 지난 상세(경쟁률·접수건수)는
비공개다. 유료 프로그램에서 받은 원본 엑셀(`전국 청약경쟁률.xlsx`, 2000.12~2026.05,
약 7,700개 단지)을 영구 아카이브(`apply_announcements`, `source='excel-legacy'`)로
적재해 그 공백을 메운다.

## 파이프라인

```
전국 청약경쟁률.xlsx
   │  ① parse_legacy_xlsx.py (openpyxl)
   ▼
scripts/legacy/legacy_announcements.ndjson   (37MB, gitignore — 재생성 가능)
   │
   ├─ ② ingest-legacy-xlsx.mjs   — DB에 없는 단지만 신규 삽입(gap-fill)
   └─ ③ enrich-legacy-from-excel.mjs — DB에 있지만 경쟁률 비어있는 단지를 UPDATE(보강)
   ▼
Supabase  public.apply_announcements
```

②③ 모두 `scripts/legacy/matchKey.mjs`(이름+분양월+지역 정규화 매칭 키)를 공유한다.
옛 청약홈 detail 스캔(`applyhome-detail`)은 지역을 정식명("서울특별시")으로,
엑셀/odcloud 는 단축명("서울")으로 저장해 표기가 다르므로, 매칭 전 정식명→단축명
별칭 테이블로 정규화한다(안 하면 매칭 실패로 중복 삽입됨 — 실제로 1차 적재에서 발생).

### ① 파싱 (NDJSON 생성) — 파이썬

```bash
pip install openpyxl
python scripts/legacy/parse_legacy_xlsx.py "<xlsx 경로>" scripts/legacy/legacy_announcements.ndjson
```

### ② 적재 (Supabase) — Node

```bash
npm install                        # @supabase/supabase-js 등 설치
# .env 에 VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 설정 후
node --env-file=.env scripts/ingest-legacy-xlsx.mjs --dry-run --max-month 202001   # 검증만(DB 조회는 하되 쓰기 없음)
node --env-file=.env scripts/ingest-legacy-xlsx.mjs --max-month 202001            # 실제 적재(2020-01 이전만)
```

## 기존 데이터와의 병합 전략 — "DB가 항상 우선" (gap-fill 전용, 삭제 없음)

Estate OS Supabase 에는 이미 `backfill.mjs` 결과가 있다:
`applyhome-detail`(2014~2019, **공급정보만·경쟁률 없음**) + `odcloud`(2020-02~, 경쟁률有, 일부 불완전).

**초안(기간으로 통째 삭제 후 엑셀로 교체)은 폐기했다.** 이유: 엑셀은 유료 프로그램
원본이라도 완전하지 않다 — 예를 들어 기존 DB에 있는 "광주 수완지구 수완채리치"는
엑셀에 전혀 없다. 기간 단위로 기존 행을 지우고 엑셀로 채우면, **엑셀에 없는 단지는
그대로 영구 소실**된다. 이를 막기 위해 **삭제를 아예 하지 않고, "DB에 없는 단지만
엑셀에서 추가(gap-fill)"** 방식으로 바꿨다.

`ingest-legacy-xlsx.mjs`가 적재 전에 하는 일:
1. `apply_announcements` 에서 로딩 범위(예: `notice_month <= 202001`)에 해당하는
   기존 `house_name, notice_month, region` 을 전부 조회.
2. 엑셀 각 행을 **이름(공백·괄호 제거)+분양월+지역** 키로 대조 — 이미 DB에 있으면
   **건너뛴다**(DB 우선, 절대 덮어쓰거나 지우지 않음). 없는 것만 신규 삽입.
3. 실행 로그에 `DB에 이미 존재 → 건너뜀 N건` / `신규 추가 대상 M건` 이 출력된다.

이름 매칭이라 완벽하진 않다(표기 차이로 인한 극소수 오탐 가능) — 결과적으로 생기는
중복은 아래 5)번 쿼리로 사후 확인한다.

**주택유형 필터(공공임대·행복주택·국민주택 제외)는 기존과 동일하게 유지**하되 이제
"삭제"가 아니라 "애초에 엑셀에서 들여오지 않음"으로 적용된다 — `ingest-legacy-xlsx.mjs`
는 이제 **기본값으로** `공공임대` 태그(`detail.houseType`)가 붙은 행을 제외한다
(민간임대·일반분양만 삽입). 태깅 정규식에 `국민`·`공임`(공공임대 축약)·`공공분양`
같은 표현도 포함해 예: `e편한세상 대구금호 공공분양 (국민)`, `경남혁신A5 10년공임
잔여 및 예비` 도 정상적으로 걸러진다. 끄고 싶으면 `--include-public-rental`.

2020-02~현재(실제 크롤/재크롤) 쪽 국민주택 제외는 이미 코드에 반영되어 있다:
- **라이브 크롤**(`apply-archive-sync.mjs` → `ApplyHomeCrawler`, `lib/applyhome/crawler.mjs:21`)
  은 원래부터 `houseDetailSecd: '01'`(민영)로 고정 조회 — 국민주택이 아예 안 들어온다.
- **odcloud 재크롤**(`backfill.mjs` → `lib/applyhome/odcloud.mjs`의 `fetchSupplyMonth`)은
  국민/민영 필드가 없어 둘 다 들어오고 있었다 → `HOUSE_SECD_NM` 등 후보 필드로 국민주택을
  걸러내도록 수정함. odcloud 응답 필드명이 예상과 다르면 실행 로그에
  `주택구분 필드를 찾지 못해 국민주택 필터 비활성` 경고가 뜬다 — 뜨면 실제 필드명을
  확인해 `odcloud.mjs`의 `houseSecdText()` 후보 목록에 추가해야 한다.

### 실행 순서 (삭제 단계 없음)

```bash
# 1) 엑셀 2020-01 이전 gap-fill 적재 — DB에 이미 있는 단지는 자동으로 건너뜀
node --env-file=.env scripts/ingest-legacy-xlsx.mjs --dry-run --max-month 202001   # 먼저 몇 건 신규인지 확인
node --env-file=.env scripts/ingest-legacy-xlsx.mjs --max-month 202001
# 2) 2020-02~현재 실제 데이터 재크롤(ODCLOUD_SERVICE_KEY 필요) — 국민주택 자동 제외됨
node --env-file=.env scripts/backfill.mjs --from 202002
# 2.5) 기존 행(주로 applyhome-detail, 2014~2019) 중 경쟁률 비어있는 것만 엑셀로 보강
#      — house_manage_no 는 그대로, 경쟁률·접수건수만 UPDATE. 이미 값 있는 행은 안 건드림.
node --env-file=.env scripts/enrich-legacy-from-excel.mjs --dry-run --max-month 202001
node --env-file=.env scripts/enrich-legacy-from-excel.mjs --max-month 202001
```
```sql
-- 2.6) 지역 표기 불일치 버그(정식명 vs 단축명)로 1차 gap-fill 때 잘못 들어간 중복 정리.
--      matchKey.mjs 적용 이후 재실행분은 정상이라 안전 — 아래로 실제 중복 쌍만 확인:
select house_name, notice_month, region, house_manage_no, detail->>'source' as source
from public.apply_announcements
where (house_name, notice_month) in (
  select house_name, notice_month from public.apply_announcements
  group by 1,2 having count(*) > 1
)
order by house_name, notice_month;
-- 결과를 보고, EXCEL- 접두 키 쪽이 중복이면 그 행만 골라 삭제(진짜 house_manage_no
-- 쪽을 항상 남긴다 — DB 우선 원칙):
-- delete from public.apply_announcements where house_manage_no = 'EXCEL-...' and pblanc_no = '...';

-- 3) (선택) 이미 DB에 있던 pre-2020-02 공공임대/행복/국민주택 행 정리 —
--    이건 "기간 삭제"가 아니라 "이름/유형으로 골라낸" 정리라 일반분양 손실 위험이 없다.
--    삭제 전 분류 확인:
select
  case
    when house_name ~ '민간임대|공공지원민간|뉴스테이|기업형임대|장기일반민간' then '민간임대(유지)'
    when house_name ~ '행복주택|국민임대|영구임대|공공임대|장기전세|전세임대|매입임대|통합공공|분양전환|[0-9]+년임대|[0-9]+년공임|공임|공공분양|\(국민\)|국민주택' then '공공임대/행복/국민(제외 대상)'
    else '일반분양(유지)'
  end as 분류, count(*)
from public.apply_announcements where notice_month < '202002' group by 1;

delete from public.apply_announcements
where notice_month < '202002'
  and house_name ~ '행복주택|국민임대|영구임대|공공임대|장기전세|전세임대|매입임대|통합공공|분양전환|[0-9]+년임대|[0-9]+년공임|공임|공공분양|\(국민\)|국민주택'
  and house_name !~ '민간임대|공공지원민간|뉴스테이|기업형임대|장기일반민간';

-- 4) 2020-02 이후도 동일하게(민간임대·일반분양 유지, 공공임대/행복/국민 제외)
delete from public.apply_announcements
where notice_month >= '202002'
  and house_name ~ '행복주택|국민임대|영구임대|공공임대|장기전세|전세임대|매입임대|통합공공|분양전환|[0-9]+년임대|[0-9]+년공임|공임|공공분양|\(국민\)|국민주택'
  and house_name !~ '민간임대|공공지원민간|뉴스테이|기업형임대|장기일반민간';

-- 5) 중복 검증(gap-fill 이름매칭이 놓친 경우만 남음 — 거의 0)
select house_name, notice_month, count(*) c from public.apply_announcements
group by 1,2 having count(*) > 1 order by c desc limit 50;
```

> ⚠️ 이전에 "1단계(기간 통째 삭제)" SQL을 이미 실행하셨다면, 그 시점에 지워진
> pre-2020-02 일반분양 행(수완채리치류)은 엑셀에 없는 한 복구되지 않는다.
> `backfill.mjs`(기본 동작, `--skip-old` 없이 `--from 201501`)로 해당 구간을
> 다시 스캔하면 복구 가능(단, 경쟁률은 여전히 없음 — 원래도 공급정보만 있던 데이터).

## 엑셀 ↔ 청약홈 스키마 매핑

엑셀은 **주택형당 1행의 요약 통계**라, 청약홈 원장(해당/기타지역 × 1·2순위 접수건수,
청약결과 상태, 특별공급)보다 정보가 적다. **가진 값만 정직하게** 담고 없는 칸은 `-`.

### `apply_announcements` 컬럼

| 컬럼 | 출처(엑셀) | 비고 |
|---|---|---|
| `house_manage_no` | `EXCEL-<sha1(단지명\|분양월\|도시\|시군구\|읍면동)[:12]>` | 엑셀엔 실제 관리번호 없음 → 합성키 |
| `pblanc_no` | `EXCEL` (동일 identity 재등장 시 `EXCEL-2`…) | 유일성 보장 |
| `region` / `supply_area_code` | 도시 → 청약홈 공급지역 단축명(서울특별시→서울 등) | 둘 다 동일값 — 시/도 필터 검색(`queryArchive` `eq supply_area_code`)에 잡히도록. 원문은 `detail.location` 보존 |
| `house_name` | 아파트 | |
| `notice_date` / `notice_month` | 분양일(YYYY.MM 실수) | `YYYY-MM` / `YYYYMM` |
| `total_units` | 총세대수(요약행) | |
| `first_round_applications` | 1순위 청약자수(요약행) | 리스트뷰 "1순위 접수" |
| `average_competition_rate` | 전체경쟁률(1~2순위, 요약행) | |
| `max_competition_rate` | 주택형별 전체경쟁률의 최댓값 | 엑셀엔 단지 최고값이 없어 상세행에서 산출 |
| `constructor`·`subscription_period`·`announcement_date`·`subscription_result` | — | 엑셀에 없음 → `null` |

### `detail` jsonb (모달이 그대로 렌더)

- `competition.rows` — **11열 DetailCell 그리드**로 청약홈 일반공급 표에 끼워맞춤:
  `[주택형, 공급세대수, 순위, 지역, 접수건수, 순위내경쟁률, 청약결과, 가점지역, 최저, 최고, 평균]`
  - 주택형 = 전용면적+분양면적 접미문자(예 `059.7800A`)
  - 공급세대수 = `일반공급`, 접수건수 = `총청약자수(1~2순위)`, 순위내경쟁률 = `전체경쟁률(1~2순위)`
  - 가점 최저/최고/평균 = 엑셀 값 그대로
  - 순위·지역 = `전체`(미분리), 청약결과·가점지역 = `-`(원본 없음)
  - 마지막에 `총합계` 행 추가(요약행 값)
- `specialSupply` = `null` (엑셀에 특별공급 없음 → 모달 특별공급 탭 비활성)
- `homepageUrl`·`noticeUrl`·`detailUrl` = `null` (링크 없음 → 상단 버튼 숨김)
- `source` = `'excel-legacy'`, `location`·`moveInDate`, **`legacyUnits`**(원본 21컬럼 손실 없이 보존)

(병합 전략은 위 "기존 데이터와의 병합 전략" 절 참고 — 기간으로 소스를 갈라 교차 중복을 없앤다.)
