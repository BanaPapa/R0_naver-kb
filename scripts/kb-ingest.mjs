// KB 시계열 엑셀 → public/data/*.json 인제스트 (결정적 재생성).
//
// 사용법:
//   node scripts/kb-ingest.mjs --weekly "C:\...\20260629_주간시계열.xlsx" --monthly "C:\...\202606_월간 주택 시계열.xlsx"
//   (--out public/data 기본. --dry 로 쓰기 없이 diff 리포트만.)
//
// 산출물(스키마는 클라이언트 로더와 계약 — 변경 금지):
//   kb-weekly.json           { dates[], data: { "시도|이름"|집계: {saleIndex,jeonseIndex,saleChange,jeonseChange} } }
//   kb-weekly-trade.json     { dates[], data: { 상위지역: {buyerAdvantage,saleActivity,jeonseSupply,jeonseActivity} } }
//   kb-monthly.json          { dates[], regions[{regionPath,region,level,parentPath}], data: { "전국>…": {5개 지표} } }
//   kb-monthly-trade.json    { dates[], data: { 상위지역: {4개 지표} } }
//   kb-monthly-forecast.json { dates[], data: { 상위지역: {saleForecast,jeonseForecast} } }
//
// 시트 구조 근거: docs/KB_TIMESERIES_DATA_REPORT.md (§2 주간, §3 월간, §3-2 날짜축 규칙)

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeLabel, canon, createTracker, AGGREGATES } from './kb-regions.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// ── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const WEEKLY_XLSX = argOf('weekly');
const MONTHLY_XLSX = argOf('monthly');
const OUT_DIR = argOf('out') ?? 'public/data';
const DRY = args.includes('--dry');

if (!WEEKLY_XLSX || !MONTHLY_XLSX) {
  console.error('사용법: node scripts/kb-ingest.mjs --weekly <주간.xlsx> --monthly <월간.xlsx> [--out public/data] [--dry]');
  process.exit(1);
}

// ── 공용 파서 ─────────────────────────────────────────────────
const num = v => (typeof v === 'number' && isFinite(v) ? v : null); // '-' 등 문자열 → null

// 엑셀 시리얼 → 'YYYY-MM-DD' (1900 date system)
function serialToIso(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return d.toISOString().slice(0, 10);
}
const isSerialDate = v => typeof v === 'number' && v > 30000 && v < 60000;

// 월간 앵커 라벨 → { y, m }. 형식: 86.1 / '86.1 / 2013.4 / 2016. 1 / '98.12
function parseMonthAnchor(label) {
  const s = String(label).replace(/\s+/g, '').replace(/^'/, '');
  const m = /^(\d{2,4})\.(\d{1,2})/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 100) y += y >= 80 ? 1900 : 2000; // 86→1986, 13→2013
  if (mo < 1 || mo > 12) return null;
  return { y, m: mo };
}
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

// 월간 A열 날짜 상태 머신.
// 규칙: 연도는 바뀌는 행에만 `'86.1`/`2013.4` 로 표기(리싱크), 이후 행은 월 숫자만.
// 월 숫자가 직전 월 이하로 줄면 연도+1 (반기/불규칙 간격도 흡수).
// 날짜로 해석 불가한 행(빈 행·주석)은 null 반환 → 호출부가 스킵.
function createMonthAxis(sheetName) {
  let cur = null; // { y, m }
  return function dateFor(cell) {
    const a = parseMonthAnchor(cell);
    if (a) {
      if (cur && (a.y < cur.y || (a.y === cur.y && a.m <= cur.m))) {
        throw new Error(`${sheetName}: 날짜축 역행 — ${ym(cur.y, cur.m)} 다음에 ${ym(a.y, a.m)}`);
      }
      cur = a;
      return ym(cur.y, cur.m);
    }
    const n = Number(String(cell ?? '').trim());
    if (cur && Number.isInteger(n) && n >= 1 && n <= 12) {
      cur = n > cur.m ? { y: cur.y, m: n } : { y: cur.y + 1, m: n };
      return ym(cur.y, cur.m);
    }
    return null;
  };
}

// 시트 → 2차원 배열
function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`시트를 찾을 수 없음: ${name}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
}

// ── 주간: 시세 시트(플랫 헤더, A열 시리얼) ─────────────────────
// 반환: { series: Map<key, Map<date, number>>, dates: Set }
function parseWeeklyFlat(wb, sheetName) {
  const rows = sheetRows(wb, sheetName);
  const header = rows[1] ?? []; // r1 한글 지역
  const classify = createTracker();
  const cols = []; // { col, key }
  for (let c = 1; c < header.length; c++) {
    const label = normalizeLabel(header[c]);
    if (!label) continue;
    const cls = classify(label);
    if (!cls) continue;
    const key =
      cls.kind === 'aggregate' || cls.kind === 'sido'
        ? cls.label
        : `${cls.sido ?? ''}|${cls.label}`; // 주간은 시·구 모두 "시도|이름" 평면 키 (클라이언트 계약)
    cols.push({ col: c, key });
  }

  const series = new Map();
  const dates = new Set();
  for (const row of rows) {
    if (!row || !isSerialDate(row[0])) continue;
    const date = serialToIso(row[0]);
    dates.add(date);
    for (const { col, key } of cols) {
      const v = num(row[col]);
      if (v === null) continue;
      let m = series.get(key);
      if (!m) series.set(key, (m = new Map()));
      if (!m.has(date)) m.set(date, v); // 중복 키(제주도→제주특별자치도 병합)는 선값 우선
    }
  }
  return { series, dates };
}

// ── 그룹형 시트(지역당 N열 구성비+지수) — 주간 5~8·월간 21~26 ──
// indexAt: 그룹 시작(지역 라벨 열)로부터 지수 열까지의 오프셋.
//   주간 5~8: +2 (구성비2+지수) · 월간 21/22/24: +3 (구성비3+지수)
//   월간 23.전세수급: +2 (수요>공급|수요<공급|지수|수요≒공급 — 지수가 3번째!)
//   월간 25/26 전망: +5 (응답 5단계+지수)
// dateKind: 'serial' | 'month'
function parseGrouped(wb, sheetName, indexAt, dateKind) {
  const rows = sheetRows(wb, sheetName);
  const header = rows[1] ?? []; // r1: 그룹 시작 열에만 지역 라벨
  const cols = []; // { col: 지수열, key }
  for (let c = 1; c < header.length; c++) {
    const label = normalizeLabel(header[c]);
    if (!label) continue;
    cols.push({ col: c + indexAt, key: canon(label) });
  }

  // 데이터 행 순회 — 주간은 A열 시리얼, 월간은 날짜 상태 머신.
  // 값이 하나도 없는 행은 날짜 축을 전진시키지 않는다(시트 하단의 차트용 요약 블록 방어).
  const series = new Map();
  const dates = new Set();
  const dateFor = createMonthAxis(sheetName);
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (dateKind === 'serial') {
      if (!isSerialDate(row[0])) continue;
      pushRow(serialToIso(row[0]), row);
    } else {
      if (!cols.some(({ col }) => num(row[col]) !== null)) continue;
      const date = dateFor(row[0]);
      if (date) pushRow(date, row);
    }
  }
  function pushRow(date, row) {
    dates.add(date);
    for (const { col, key } of cols) {
      const v = num(row[col]);
      if (v === null) continue;
      let m = series.get(key);
      if (!m) series.set(key, (m = new Map()));
      if (!m.has(date)) m.set(date, v);
    }
  }
  return { series, dates };
}

// ── 월간: 계층형 시세 시트(2단 헤더, A열 연도전파) ───────────────
// 반환: { series: Map<regionPath, Map<date, number>>, dates: Set, order: regionPath[] }
function parseMonthlyHierarchy(wb, sheetName) {
  const rows = sheetRows(wb, sheetName);
  const h1 = rows[1] ?? [];
  const h2 = rows[2] ?? [];
  const classify = createTracker();
  const cols = []; // { col, path }
  const order = [];
  for (let c = 1; c < Math.max(h1.length, h2.length); c++) {
    const label = normalizeLabel(h1[c]) || normalizeLabel(h2[c]);
    if (!label || label === '제주/서귀포') {
      if (label === '제주/서귀포') continue; // 자리표시자(데이터 없음, 계층 불명)
      continue;
    }
    const cls = classify(label);
    if (!cls) continue;
    let path;
    if (cls.label === '전국') path = '전국';
    else if (cls.kind === 'aggregate' || cls.kind === 'sido') path = `전국>${cls.label}`;
    else if (cls.kind === 'city') path = `전국>${cls.sido}>${cls.label}`;
    else path = cls.city ? `전국>${cls.sido}>${cls.city}>${cls.label}` : `전국>${cls.sido}>${cls.label}`;
    cols.push({ col: c, path });
    if (!order.includes(path)) order.push(path);
  }

  // 지수·비율·가격 시트에서 0은 존재할 수 없는 값 — KB가 미조사 지역에 채워둔
  // 자리표시자이므로 null 처리한다(예: 단독/연립 시군구 열의 0).
  const series = new Map();
  const dates = new Set();
  const dateFor = createMonthAxis(sheetName);
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!cols.some(({ col }) => { const v = num(row[col]); return v !== null && v !== 0; })) continue;
    const date = dateFor(row[0]);
    if (!date) continue;
    dates.add(date);
    for (const { col, path } of cols) {
      const v = num(row[col]);
      if (v === null || v === 0) continue;
      let mm = series.get(path);
      if (!mm) series.set(path, (mm = new Map()));
      if (!mm.has(date)) mm.set(date, v);
    }
  }
  return { series, dates, order };
}

// ── 조립: 지표별 시리즈 맵 → { dates, data } ─────────────────────
// omitEmptyMetrics: 지역별로 전부 null인 지표 배열을 아예 생략(월간 — 클라이언트가
// Partial 로 읽고 없는 지표는 상위 폴백. 좁은 축 지표의 용량 낭비 방지).
// 주간은 로더가 4개 지표 배열을 모두 기대하므로 생략하지 않는다.
function assemble(metricSeries /* { metric: {series,dates} } */, { omitEmptyMetrics = false } = {}) {
  const dateSet = new Set();
  for (const { dates } of Object.values(metricSeries)) for (const d of dates) dateSet.add(d);
  const dates = [...dateSet].sort();

  const keys = new Set();
  for (const { series } of Object.values(metricSeries)) for (const k of series.keys()) keys.add(k);

  const data = {};
  for (const key of keys) {
    const entry = {};
    let any = false;
    for (const [metric, { series }] of Object.entries(metricSeries)) {
      const m = series.get(key);
      let metricAny = false;
      const arr = dates.map(d => {
        const v = m?.get(d);
        if (v != null) metricAny = true;
        return v ?? null;
      });
      if (metricAny) any = true;
      if (metricAny || !omitEmptyMetrics) entry[metric] = arr;
    }
    if (any) data[key] = entry; // 전부 null(자리표시자 열)은 제외 — 값이 생기면 자동 포함
  }
  return { dates, data };
}

// ── 월간: 중위가격 시트(43·44) — 지역 그룹 = 종합(라벨 열)|아파트|단독|연립 ──
// 아파트 열(라벨 열 +1)만 추출. 상위 25지역뿐이라 regionPath 는 "전국>{지역}".
// 반환 형태는 parseMonthlyHierarchy 와 동일.
function parseMedianApt(wb, sheetName) {
  const rows = sheetRows(wb, sheetName);
  const h1 = rows[1] ?? [];
  const h2 = rows[2] ?? [];
  const cols = [];
  const order = [];
  for (let c = 1; c < h1.length; c++) {
    const label = canon(normalizeLabel(h1[c]));
    if (!label) continue;
    if (normalizeLabel(h2[c + 1]) !== '아파트') continue; // 그룹 폭이 달라도 아파트 열만 신뢰
    const path = label === '전국' ? '전국' : `전국>${label}`;
    cols.push({ col: c + 1, path });
    if (!order.includes(path)) order.push(path);
  }
  const series = new Map();
  const dates = new Set();
  const dateFor = createMonthAxis(sheetName);
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!cols.some(({ col }) => { const v = num(row[col]); return v !== null && v !== 0; })) continue;
    const date = dateFor(row[0]);
    if (!date) continue;
    dates.add(date);
    for (const { col, path } of cols) {
      const v = num(row[col]);
      if (v === null || v === 0) continue; // 가격 0 = 미조사 자리표시자
      let m = series.get(path);
      if (!m) series.set(path, (m = new Map()));
      if (!m.has(date)) m.set(date, v);
    }
  }
  return { series, dates, order };
}

// ── 월간: 선도아파트50지수(시트 16) — 지역 없음(전국 단일), B열이 지수 ──
function parseLeading50(wb, sheetName) {
  const rows = sheetRows(wb, sheetName);
  const series = new Map([['전국', new Map()]]);
  const dates = new Set();
  const dateFor = createMonthAxis(sheetName);
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const v = num(row[1]);
    if (v === null || v === 0) continue; // 값 없는 행은 날짜 축도 전진 금지
    const date = dateFor(row[0]);
    if (!date) continue;
    dates.add(date);
    series.get('전국').set(date, v);
  }
  return { series, dates, order: ['전국'] };
}

// ── 기존 산출물과 diff 리포트 ─────────────────────────────────
function diffReport(name, next, outFile) {
  console.log(`\n── ${name}`);
  const regions = Object.keys(next.data).length;
  console.log(`   지역 ${regions} · 기간 ${next.dates[0]} ~ ${next.dates[next.dates.length - 1]} (${next.dates.length}개 시점)`);
  if (!existsSync(outFile)) {
    console.log('   (기존 파일 없음 — 신규 생성)');
    return;
  }
  const prev = JSON.parse(readFileSync(outFile, 'utf8'));
  const pKeys = new Set(Object.keys(prev.data));
  const nKeys = new Set(Object.keys(next.data));
  const added = [...nKeys].filter(k => !pKeys.has(k));
  const removed = [...pKeys].filter(k => !nKeys.has(k));
  const newDates = next.dates.filter(d => !prev.dates.includes(d));
  if (added.length) console.log(`   + 지역 추가(${added.length}): ${added.slice(0, 10).join(', ')}${added.length > 10 ? ' 외' : ''}`);
  if (removed.length) console.log(`   - 지역 제거(${removed.length}): ${removed.slice(0, 10).join(', ')}${removed.length > 10 ? ' 외' : ''}`);
  if (newDates.length) console.log(`   + 시점 추가(${newDates.length}): ${newDates.slice(0, 6).join(', ')}${newDates.length > 6 ? ' …' : ''}`);

  // 겹치는 (지역,시점,지표) 값 비교 — 상대오차 0.1% 초과만 카운트(원천 정정 감지)
  const pIdx = new Map(prev.dates.map((d, i) => [d, i]));
  let compared = 0, mismatched = 0;
  const samples = [];
  for (const k of nKeys) {
    if (!pKeys.has(k)) continue;
    for (const metric of Object.keys(next.data[k])) {
      const pArr = prev.data[k][metric];
      if (!pArr) continue;
      const nArr = next.data[k][metric];
      for (let i = 0; i < next.dates.length; i++) {
        const j = pIdx.get(next.dates[i]);
        if (j === undefined) continue;
        const a = nArr[i], b = pArr[j];
        if (a == null || b == null) continue;
        compared++;
        if (Math.abs(a - b) > Math.max(1e-9, Math.abs(b) * 0.001)) {
          mismatched++;
          if (samples.length < 5) samples.push(`${k}·${metric}@${next.dates[i]}: ${b} → ${a}`);
        }
      }
    }
  }
  console.log(`   값 비교 ${compared.toLocaleString()}건 중 상이 ${mismatched}건${mismatched ? ' (원천 정정 가능성)' : ''}`);
  for (const s of samples) console.log(`     · ${s}`);
}

// ── 실행 ─────────────────────────────────────────────────────
console.log('주간 파일:', WEEKLY_XLSX);
console.log('월간 파일:', MONTHLY_XLSX);
const wbW = XLSX.readFile(WEEKLY_XLSX, { dense: true });
const wbM = XLSX.readFile(MONTHLY_XLSX, { dense: true });

// 1) kb-weekly.json — 시트 1~4
const weekly = assemble({
  saleChange: parseWeeklyFlat(wbW, '1.매매증감'),
  jeonseChange: parseWeeklyFlat(wbW, '2.전세증감'),
  saleIndex: parseWeeklyFlat(wbW, '3.매매지수'),
  jeonseIndex: parseWeeklyFlat(wbW, '4.전세지수'),
});

// 2) kb-weekly-trade.json — 시트 5~8 (지역당 3열)
const weeklyTrade = assemble({
  buyerAdvantage: parseGrouped(wbW, '5.매수우위', 2, 'serial'),
  saleActivity: parseGrouped(wbW, '6.매매거래활발', 2, 'serial'),
  jeonseSupply: parseGrouped(wbW, '7.전세수급', 2, 'serial'),
  jeonseActivity: parseGrouped(wbW, '8.전세거래활발', 2, 'serial'),
});

// 3) kb-monthly.json — 계층형 아파트 시세·시장(2·6·28·47·48)
//    + 중위 아파트가(43·44) + 선도50(16). 아파트 전용 — 종합/단독/연립 시트는 다루지 않는다.
const mSale = parseMonthlyHierarchy(wbM, '2.매매APT');
const mJeonse = parseMonthlyHierarchy(wbM, '6.전세APT');
const mRatio = parseMonthlyHierarchy(wbM, '28.아파트매매전세비');
const mAvgSale = parseMonthlyHierarchy(wbM, '47.㎡당아파트평균매매');
const mAvgJeonse = parseMonthlyHierarchy(wbM, '48.㎡당아파트평균전세');
const mMedianSale = parseMedianApt(wbM, '43.중위매매');
const mMedianJeonse = parseMedianApt(wbM, '44.중위전세');
const mLeading = parseLeading50(wbM, '16.선도50');
const monthly = assemble(
  {
    saleAptIndex: mSale,
    jeonseAptIndex: mJeonse,
    aptSaleJeonseRatio: mRatio,
    aptAvgSalePerM2: mAvgSale,
    aptAvgJeonsePerM2: mAvgJeonse,
    // 중위 아파트 가격 (만원/호, 상위 25지역)
    medianAptSale: mMedianSale,
    medianAptJeonse: mMedianJeonse,
    // KB 선도아파트 50지수 (전국 단일)
    leading50Index: mLeading,
  },
  { omitEmptyMetrics: true },
);
// 지역 메타(트리): 시트 등장 순서 유지, 데이터 있는 경로만
{
  const orderAll = [];
  for (const src of [mSale, mJeonse, mRatio, mAvgSale, mAvgJeonse, mMedianSale, mMedianJeonse])
    for (const p of src.order) if (!orderAll.includes(p)) orderAll.push(p);
  monthly.regions = orderAll
    .filter(p => monthly.data[p])
    .map(p => {
      const segs = p.split('>');
      return {
        regionPath: p,
        region: segs[segs.length - 1],
        level: segs.length,
        parentPath: segs.length > 1 ? segs.slice(0, -1).join('>') : null,
      };
    });
}

// 4) kb-monthly-trade.json — 시트 21~24 (지역당 4열)
const monthlyTrade = assemble({
  buyerAdvantage: parseGrouped(wbM, '21.매수우위', 3, 'month'),
  saleActivity: parseGrouped(wbM, '22.매매거래활발', 3, 'month'),
  jeonseSupply: parseGrouped(wbM, '23.전세수급', 2, 'month'), // 지수 열이 3번째(수요≒공급이 마지막)
  jeonseActivity: parseGrouped(wbM, '24.전세거래활발', 3, 'month'),
});

// 5) kb-monthly-forecast.json — 시트 25·26 (지역당 6열)
const forecast = assemble({
  saleForecast: parseGrouped(wbM, '25.KB부동산 매매가격 전망지수', 5, 'month'),
  jeonseForecast: parseGrouped(wbM, '26.KB부동산 전세가격 전망지수', 5, 'month'),
});

// ── 무결성 검증 ───────────────────────────────────────────────
// 유령 키 금지: 시도가 다른 시도의 하위로 매핑되는 오류 (기존 kb-weekly.json 결함 재발 방지)
const SIDO_NAMES = /(특별시|광역시|특별자치시|특별자치도)$|(?<!개)도$/;
for (const key of Object.keys(weekly.data)) {
  const [, leaf] = key.split('|');
  if (leaf && SIDO_NAMES.test(leaf)) throw new Error(`유령 키 감지: ${key} (시도가 하위 지역으로 매핑됨)`);
}
// 필수 지역 존재 확인
for (const must of ['전국', '서울특별시', '서울특별시|강남구', '경기도|수원시', '충청북도|상당구']) {
  if (!weekly.data[must]) throw new Error(`주간 필수 지역 누락: ${must}`);
}
for (const must of ['전국', '전국>서울특별시>강남구', '전국>경기도>수원시>장안구', '전국>전북특별자치도']) {
  if (!monthly.data[must]) throw new Error(`월간 필수 경로 누락: ${must}`);
}

// ── diff 리포트 + 쓰기 ────────────────────────────────────────
const outputs = [
  ['kb-weekly.json', weekly],
  ['kb-weekly-trade.json', weeklyTrade],
  ['kb-monthly.json', monthly],
  ['kb-monthly-trade.json', monthlyTrade],
  ['kb-monthly-forecast.json', forecast],
];
for (const [file, data] of outputs) {
  const outFile = path.join(OUT_DIR, file);
  diffReport(file, data, outFile);
  if (!DRY) {
    writeFileSync(outFile, JSON.stringify(data), 'utf8');
    console.log(`   ✓ 저장: ${outFile}`);
  }
}
console.log(DRY ? '\n(dry-run — 파일을 쓰지 않았습니다)' : '\n완료. 다음 단계: node scripts/kb-publish-bundles.mjs');
