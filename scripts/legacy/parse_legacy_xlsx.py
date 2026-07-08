#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
전국 청약경쟁률.xlsx (유료 프로그램 원본, 2000~2026) → apply_announcements NDJSON.

청약홈은 목록을 ~5년만 노출하고 5년 지난 상세(경쟁률/접수건수)는 비공개다.
이 엑셀은 2000년 이후 거의 모든 분양의 "요약 통계"를 담지만, 청약홈 원장과
스키마가 다르다(해당/기타지역·1/2순위 분리·청약결과·특별공급이 없음).
=> 가진 것만 정직하게 기존 apply_announcements + detail jsonb 로 매핑한다.

산출물: NDJSON 1줄 = apply_announcements 1행(단지-공고 1건). detail.competition.rows
는 모달이 그대로 렌더하는 11열 DetailCell 그리드(청약홈 표에 끼워맞춤, 없는 칸은 '-').

사용:
  python scripts/legacy/parse_legacy_xlsx.py "<xlsx 경로>" [출력.ndjson]
"""
import sys
import json
import hashlib
from collections import Counter

import openpyxl

# ── 엑셀 컬럼 인덱스(0-based) ─────────────────────────────
C_NAME, C_SUPAREA, C_EXAREA, C_TOTAL, C_PRICE = 0, 1, 2, 3, 4
C_CITY, C_GU, C_DONG = 5, 6, 7
C_NOTICE, C_MOVEIN = 8, 9
C_RATE_ALL, C_RATE_1ST, C_GENERAL = 10, 11, 12
C_APPS_ALL, C_APPS_1ST = 13, 14
C_REG_SUPPLY, C_REG_APPS, C_REG_RATE = 15, 16, 17
C_SCORE_TOP, C_SCORE_LOW, C_SCORE_AVG = 18, 19, 20

HEADER_TOKENS = {"아파트", "분양면적", "도시"}  # 데이터 중간에 섞인 반복 헤더 제거용

# 도시(시도) → 앱 표시용 짧은 지역명.
REGION_MAP = {
    "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구",
    "인천광역시": "인천", "광주광역시": "광주", "대전광역시": "대전",
    "울산광역시": "울산", "세종특별자치시": "세종", "경기도": "경기",
    "강원도": "강원", "강원특별자치도": "강원", "충청북도": "충북",
    "충청남도": "충남", "전라북도": "전북", "전북특별자치도": "전북",
    "전라남도": "전남", "경상북도": "경북", "경상남도": "경남",
    "제주도": "제주", "제주특별자치도": "제주",
    # 원본 데이터 특이 표기(광주광역시를 지칭) — 원문은 detail.location 에 보존.
    "전남광주통합특별시": "광주",
}


def to_num(v):
    """숫자/None. 콤마 섞인 문자열도 허용."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).replace(",", "").strip()
    if s == "" or s == "-":
        return None
    try:
        return float(s) if ("." in s) else int(s)
    except ValueError:
        return None


def to_int(v):
    n = to_num(v)
    return int(round(n)) if n is not None else None


def parse_notice(v):
    """분양일 float(YYYY.MM) → (notice_date 'YYYY-MM', notice_month 'YYYYMM'). 실패 시 (None,None)."""
    n = to_num(v)
    if n is None:
        return None, None
    year = int(n)
    month = int(round((n - year) * 100))
    if year < 1990 or year > 2100:
        return None, None
    if month < 1 or month > 12:
        # 월 정보 없음/이상 → 연도만
        return f"{year}", f"{year}00"
    return f"{year}-{month:02d}", f"{year}{month:02d}"


def fmt_ratio(v):
    """경쟁률 표기. None→'-', 그 외 불필요한 0 제거(723.06, 5, 2.5)."""
    n = to_num(v)
    if n is None:
        return "-"
    return f"{n:g}"


def fmt_htype(exarea, suparea):
    """청약홈 주택형 스타일 근사: 전용면적 3+4자리 + 분양면적 접미문자(A/B…).
       예) 전용 59.78, 분양면적 '82.01A' → '059.7800A'."""
    suffix = ""
    if suparea is not None:
        s = str(suparea).strip()
        # 끝에 붙은 알파벳(주택형 구분자) 추출
        i = len(s)
        while i > 0 and s[i - 1].isalpha():
            i -= 1
        suffix = s[i:]
    n = to_num(exarea)
    if n is None:
        base = str(exarea).strip() if exarea is not None else ""
        return f"{base}{suffix}" if base else (suffix or "-")
    return f"{int(n):03d}.{int(round((n - int(n)) * 10000)):04d}{suffix}"


def cell(v, row_span=1, show=True):
    return {"v": "" if v is None else str(v), "rowSpan": row_span, "show": show}


def region_of(city):
    if city is None:
        return None
    return REGION_MAP.get(str(city).strip(), str(city).strip())


# 단지명 → 주택유형. 청약 단지명은 유형을 거의 항상 괄호로 명시한다
# (예: '…(공공임대)', '…(국민임대)', '…(민간임대)', '…뉴스테이'). 민간임대를
# 먼저 판정해 '공공지원민간임대'가 공공으로 오분류되지 않게 한다.
import re

_RE_PRIVATE = re.compile(r"민간임대|공공지원민간|뉴스테이|기업형임대|장기일반민간")
_RE_PUBLIC = re.compile(
    r"행복주택|국민임대|영구임대|공공임대|장기전세|전세임대|매입임대|통합공공|분양전환|"
    r"[0-9]+년임대|[0-9]+년공임|공임|공공분양|\(국민\)|국민주택"
)


def house_type_of(name):
    n = str(name or "")
    if _RE_PRIVATE.search(n):
        return "민간임대"
    if _RE_PUBLIC.search(n):
        return "공공임대"
    return "일반분양"


def is_summary(row):
    return str(row[C_SUPAREA]).strip() == "전체" and str(row[C_EXAREA]).strip() == "전체"


def is_header_noise(row):
    return str(row[C_NAME]).strip() in HEADER_TOKENS or str(row[C_CITY]).strip() == "도시"


def build_detail_rows(units, summary):
    """주택형 상세행들 → 11열 DetailCell 그리드(엑셀 값만, 없는 칸은 '-') + 총합계 행."""
    grid = []
    for u in units:
        grid.append([
            cell(fmt_htype(u[C_EXAREA], u[C_SUPAREA])),      # 0 주택형
            cell(to_int(u[C_GENERAL]) if to_int(u[C_GENERAL]) is not None else "-"),  # 1 공급세대수(일반공급)
            cell("전체"),                                     # 2 순위(엑셀은 1·2순위 미분리)
            cell("전체"),                                     # 3 지역(해당/기타 미분리)
            cell(to_int(u[C_APPS_ALL]) if to_int(u[C_APPS_ALL]) is not None else "-"),  # 4 접수건수(총 1~2순위)
            cell(fmt_ratio(u[C_RATE_ALL])),                   # 5 순위내경쟁률(전체 1~2순위)
            cell("-"),                                        # 6 청약결과(원본 없음)
            cell("-"),                                        # 7 당첨가점-지역
            cell(fmt_ratio(u[C_SCORE_LOW])),                  # 8 최저
            cell(fmt_ratio(u[C_SCORE_TOP])),                  # 9 최고
            cell(fmt_ratio(u[C_SCORE_AVG])),                  # 10 평균
        ])
    # 총합계 행(청약홈 모달 하단 재현). 요약행 있으면 그 값, 없으면 합산.
    if summary is not None:
        tot_supply = to_int(summary[C_GENERAL])
        tot_apps = to_int(summary[C_APPS_ALL])
        tot_rate = fmt_ratio(summary[C_RATE_ALL])
    else:
        tot_supply = sum(filter(None, (to_int(u[C_GENERAL]) for u in units))) or None
        tot_apps = sum(filter(None, (to_int(u[C_APPS_ALL]) for u in units))) or None
        tot_rate = "-"
    grid.append([
        cell("총합계"),
        cell(tot_supply if tot_supply is not None else "-"),
        cell("-"), cell("-"),
        cell(tot_apps if tot_apps is not None else "-"),
        cell(tot_rate),
        cell("-"), cell("-"), cell("-"), cell("-"), cell("-"),
    ])
    return grid


def make_announcement(group, seen_ids):
    """단지 그룹(요약행 + 주택형 행들) → apply_announcements 행 dict."""
    summary = next((r for r in group if is_summary(r)), None)
    units = [r for r in group if not is_summary(r)]
    head = summary if summary is not None else group[0]

    name = str(head[C_NAME]).strip()
    city = head[C_CITY]
    gu = head[C_GU]
    dong = head[C_DONG]
    notice_date, notice_month = parse_notice(head[C_NOTICE])

    # 합성 식별자: 안정 identity 해시. 동일 identity 재등장 시 pblanc_no 에 접미.
    identity = f"{name}|{notice_month}|{city}|{gu}|{dong}"
    h = hashlib.sha1(identity.encode("utf-8")).hexdigest()[:12]
    hmno = f"EXCEL-{h}"
    dup = seen_ids.get(hmno, 0)
    seen_ids[hmno] = dup + 1
    pblanc = "EXCEL" if dup == 0 else f"EXCEL-{dup + 1}"

    # 단지 레벨 집계.
    total_units = to_int(head[C_TOTAL])
    if total_units is None:
        cand = [to_int(u[C_TOTAL]) for u in units if to_int(u[C_TOTAL]) is not None]
        total_units = max(cand) if cand else None
    first_round = to_int(head[C_APPS_1ST]) if summary is not None else None
    avg_rate = to_num(head[C_RATE_ALL]) if summary is not None else None
    unit_rates = [to_num(u[C_RATE_ALL]) for u in units if to_num(u[C_RATE_ALL]) is not None]
    max_rate = max(unit_rates) if unit_rates else avg_rate

    detail_rows = build_detail_rows(units, summary)

    # 원본 손실 방지용 raw(향후 실제 청약홈 데이터 병합/검증에 사용).
    legacy_units = [{
        "supplyArea": u[C_SUPAREA],
        "exclusiveArea": to_num(u[C_EXAREA]),
        "totalUnits": to_int(u[C_TOTAL]),
        "price": to_int(u[C_PRICE]),
        "generalSupply": to_int(u[C_GENERAL]),
        "rateAll": to_num(u[C_RATE_ALL]),
        "rate1st": to_num(u[C_RATE_1ST]),
        "appsAll": to_int(u[C_APPS_ALL]),
        "apps1st": to_int(u[C_APPS_1ST]),
        "regionSupply": to_int(u[C_REG_SUPPLY]),
        "regionApps": to_int(u[C_REG_APPS]),
        "regionRate": to_num(u[C_REG_RATE]),
        "scoreTop": to_num(u[C_SCORE_TOP]),
        "scoreLow": to_num(u[C_SCORE_LOW]),
        "scoreAvg": to_num(u[C_SCORE_AVG]),
    } for u in units]

    move_in_date, _ = parse_notice(head[C_MOVEIN])

    # 청약홈 공급지역 단축명('서울','경기'…) = 앱 지역필터 값(toApplyhomeRegion).
    # region/supply_area_code 둘 다 이 값이라야 시/도 선택 검색(queryArchive: eq
    # supply_area_code)에도 레거시 레코드가 잡힌다.
    region = region_of(city)

    return {
        "house_manage_no": hmno,
        "pblanc_no": pblanc,
        "supply_area_code": region,
        "region": region,
        "house_name": name,
        "constructor": None,
        "notice_date": notice_date,
        "notice_month": notice_month,
        "subscription_period": None,
        "announcement_date": None,
        "total_units": total_units,
        "first_round_applications": first_round,
        "average_competition_rate": avg_rate,
        "max_competition_rate": max_rate,
        "subscription_result": None,
        "detail": {
            "competition": {"rows": detail_rows},
            "specialSupply": None,
            "homepageUrl": None,
            "noticeUrl": None,
            "detailUrl": None,
            "source": "excel-legacy",
            "houseType": house_type_of(name),   # 일반분양 | 민간임대 | 공공임대
            "location": {"city": city, "gu": gu, "dong": dong},
            "moveInDate": move_in_date,
            "legacyUnits": legacy_units,
        },
    }


def iter_data_rows(ws):
    """헤더 위 공백/헤더행을 건너뛰고 데이터 행만 (헤더는 4번째 줄)."""
    started = False
    for row in ws.iter_rows(values_only=True):
        if not started:
            if row and str(row[C_NAME]).strip() == "아파트":
                started = True  # 헤더행 발견 — 다음부터 데이터
            continue
        if row is None or all(x is None for x in row):
            continue
        if row[C_NAME] is None:
            continue
        if is_header_noise(row):
            continue
        yield row


def main():
    if len(sys.argv) < 2:
        print("usage: parse_legacy_xlsx.py <xlsx> [out.ndjson]", file=sys.stderr)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "scripts/legacy/legacy_announcements.ndjson"

    wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
    ws = wb.active

    # (name, notice_month, city) 연속 런 단위로 그룹핑.
    groups = []
    cur, cur_key = [], None
    for row in iter_data_rows(ws):
        _, nm = None, str(row[C_NAME]).strip()
        _, month = parse_notice(row[C_NOTICE])
        key = (nm, month, str(row[C_CITY]).strip())
        if key != cur_key and cur:
            groups.append(cur)
            cur = []
        cur_key = key
        cur.append(row)
    if cur:
        groups.append(cur)

    seen_ids = {}
    stats = Counter()
    region_unknown = Counter()
    n = 0
    with open(out, "w", encoding="utf-8") as f:
        for g in groups:
            rec = make_announcement(g, seen_ids)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
            stats["with_summary"] += 1 if any(is_summary(r) for r in g) else 0
            stats["units"] += len([r for r in g if not is_summary(r)])
            if rec["notice_month"] is None or rec["notice_month"].endswith("00"):
                stats["bad_month"] += 1
            city = str(g[0][C_CITY]).strip()
            if city not in REGION_MAP:
                region_unknown[city] += 1

    dup_total = sum(v - 1 for v in seen_ids.values() if v > 1)
    print(f"✓ {n} 단지(공고) → {out}")
    print(f"  요약행 보유: {stats['with_summary']} | 주택형 상세행 총합: {stats['units']}")
    print(f"  합성키 중복 identity(접미 부여): {dup_total}")
    print(f"  분양월 결측/이상: {stats['bad_month']}")
    if region_unknown:
        print(f"  매핑 미정의 도시(원문 보존): {dict(region_unknown)}")


if __name__ == "__main__":
    main()
