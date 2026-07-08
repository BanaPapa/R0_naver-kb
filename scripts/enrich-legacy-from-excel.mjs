#!/usr/bin/env node
/**
 * 기존 apply_announcements 행(주로 source='applyhome-detail', 2014~2019 청약홈
 * detail 스캔 — 공급정보만, 경쟁률 없음) 을 엑셀(legacy_announcements.ndjson)의
 * 경쟁률·접수건수로 보강한다.
 *
 * ingest-legacy-xlsx.mjs(gap-fill)와의 차이: gap-fill 은 DB에 없는 단지만 새로
 * "삽입"하고, 이 스크립트는 DB에 이미 있지만 경쟁률이 비어있는 단지를
 * 이름+분양월+지역으로 매칭해 "그 행 자체를 UPDATE"한다 — house_manage_no/
 * pblanc_no(진짜 청약홈 관리번호)는 절대 손대지 않는다. 이미 경쟁률이 있는
 * 행은 건드리지 않는다("DB 데이터가 항상 우선" 원칙 유지 — 이건 빈 칸 보강이지
 * 덮어쓰기가 아니다).
 *
 * 필요 env (.env): VITE_SUPABASE_URL(또는 SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 *
 * 사용:
 *   node --env-file=.env scripts/enrich-legacy-from-excel.mjs --dry-run --max-month 202001
 *   node --env-file=.env scripts/enrich-legacy-from-excel.mjs --max-month 202001
 */
import { readFileSync } from 'node:fs';
import { getSupabaseAdmin } from '../lib/supabase/serverClient.mjs';
import { matchKey, normName, normRegion } from './legacy/matchKey.mjs';

const SELECT_PAGE = 1000;
const CONCURRENCY = 8;
const MIN_SUBSTRING_LEN = 4; // 이보다 짧은 이름은 포함관계만으로 매칭하면 오탐 위험이 큼

function parseArgs(argv) {
  const a = { file: 'scripts/legacy/legacy_announcements.ndjson', dryRun: false, maxMonth: '202001' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--max-month') a.maxMonth = (argv[++i] || '').replace(/[^\d]/g, '').slice(0, 6) || a.maxMonth;
    else if (!arg.startsWith('--')) a.file = arg;
  }
  return a;
}

function readExcelIndex(file) {
  const text = readFileSync(file, 'utf-8');
  const map = new Map();          // 정확 매칭: matchKey → rec
  const byMonthRegion = new Map(); // 보조 매칭: 'month|region' → rec[]
  text.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    const rec = JSON.parse(s);
    map.set(matchKey(rec.house_name, rec.notice_month, rec.region), rec);
    const mrKey = `${rec.notice_month}|${normRegion(rec.region)}`;
    if (!byMonthRegion.has(mrKey)) byMonthRegion.set(mrKey, []);
    byMonthRegion.get(mrKey).push(rec);
  });
  return { map, byMonthRegion };
}

// 정확 매칭 실패 시 같은 월+지역 안에서 포함관계(substring)로 재시도.
// 옛 스캔 이름이 "대구 서호동 효성노블시티"처럼 지역명을 접두어로 더 갖고 있어
// 엑셀의 "서호동효성노블시티"를 부분 포함하는 경우를 잡기 위함.
function findSubstringMatch(row, byMonthRegion) {
  const key = `${row.notice_month}|${normRegion(row.region)}`;
  const candidates = byMonthRegion.get(key) || [];
  const n1 = normName(row.house_name);
  if (n1.length < MIN_SUBSTRING_LEN) return null;
  for (const c of candidates) {
    const n2 = normName(c.house_name);
    if (n2.length < MIN_SUBSTRING_LEN) continue;
    if (n1.includes(n2) || n2.includes(n1)) return c;
  }
  return null;
}

// 경쟁률이 비어있는 기존 행만 후보로 삼는다(이미 값이 있는 행은 조회 대상에서 제외
// — DB 우선 원칙상 애초에 건드릴 일이 없다).
async function fetchEmptyCompetitionRows(maxMonth) {
  const admin = getSupabaseAdmin();
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from('apply_announcements')
      .select('house_manage_no,pblanc_no,house_name,notice_month,region,total_units,first_round_applications,detail')
      .is('average_competition_rate', null)
      .lte('notice_month', maxMonth)
      .range(from, from + SELECT_PAGE - 1);
    if (error) throw new Error(`기존 데이터 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < SELECT_PAGE) break;
    from += SELECT_PAGE;
  }
  return rows;
}

// 기존 행의 detail 은 유지하고(홈페이지/공고 링크 등 실제 크롤 값 보존), 경쟁률
// 관련 필드만 엑셀 값으로 채운다. specialSupply 는 기존 값이 있으면 그걸 우선.
function buildUpdate(existing, excel) {
  const detail = existing.detail && typeof existing.detail === 'object' ? existing.detail : {};
  return {
    total_units: existing.total_units ?? excel.total_units,
    first_round_applications: existing.first_round_applications ?? excel.first_round_applications,
    average_competition_rate: excel.average_competition_rate,
    max_competition_rate: excel.max_competition_rate,
    detail: {
      ...detail,
      competition: excel.detail.competition,
      specialSupply: detail.specialSupply ?? excel.detail.specialSupply,
      legacyUnits: excel.detail.legacyUnits,
      houseType: excel.detail.houseType,
      enrichedFrom: 'excel-legacy',
    },
    last_crawled_at: new Date().toISOString(),
  };
}

async function updateOne(row, payload) {
  const { error } = await getSupabaseAdmin()
    .from('apply_announcements')
    .update(payload)
    .eq('house_manage_no', row.house_manage_no)
    .eq('pblanc_no', row.pblanc_no);
  if (error) throw new Error(`update 실패(${row.house_manage_no}): ${error.message}`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!getSupabaseAdmin()) {
    console.error('✗ Supabase 미설정 — .env 에 VITE_SUPABASE_URL(또는 SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY 필요');
    process.exit(1);
  }

  const { map: excelMap, byMonthRegion } = readExcelIndex(args.file);
  console.log(`엑셀 레코드: ${excelMap.size}건 로드`);

  const candidates = await fetchEmptyCompetitionRows(args.maxMonth);
  console.log(`보강 대상(경쟁률 비어있는 기존 행, ~${args.maxMonth}): ${candidates.length}건`);

  const matched = [];
  const matchedFuzzy = [];
  let unmatched = 0;
  for (const row of candidates) {
    const exact = excelMap.get(matchKey(row.house_name, row.notice_month, row.region));
    if (exact && exact.average_competition_rate != null) { matched.push({ row, excel: exact }); continue; }
    const fuzzy = findSubstringMatch(row, byMonthRegion);
    if (fuzzy && fuzzy.average_competition_rate != null) { matchedFuzzy.push({ row, excel: fuzzy }); continue; }
    unmatched += 1;
  }
  console.log(`  정확 매칭(보강 예정): ${matched.length}건`);
  console.log(`  포함관계 보조 매칭(보강 예정): ${matchedFuzzy.length}건`);
  console.log(`  매칭 안 됨(엑셀에도 없음 — 그대로 둠): ${unmatched}건`);

  const allMatched = [...matched, ...matchedFuzzy];

  if (args.dryRun) {
    console.log('✓ dry-run: 실제 UPDATE 없음. 포함관계 매칭 샘플(오탐 여부 확인용):');
    matchedFuzzy.slice(0, 15).forEach(({ row, excel }) => {
      console.log(`  DB:"${row.house_name}"(${row.region}) ← 엑셀:"${excel.house_name}"(${excel.region}) 경쟁률 ${excel.average_competition_rate}`);
    });
    process.exit(0);
  }

  let done = 0;
  for (let i = 0; i < allMatched.length; i += CONCURRENCY) {
    const batch = allMatched.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(({ row, excel }) => updateOne(row, buildUpdate(row, excel))));
    done += batch.length;
    console.log(`  update ${done}/${allMatched.length}`);
  }
  console.log(`\n✓ 보강 완료 — ${done}건 UPDATE (정확 ${matched.length} + 포함관계 ${matchedFuzzy.length}) — 엑셀에 없어 여전히 경쟁률 없는 행: ${unmatched}건`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
