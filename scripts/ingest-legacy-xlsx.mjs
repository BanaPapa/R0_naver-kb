#!/usr/bin/env node
/**
 * 레거시 분양 통계(유료 프로그램 원본, 2000~2026) 적재 — gap-fill 전용.
 * parse_legacy_xlsx.py 가 만든 NDJSON(= apply_announcements 행 1줄씩)을 읽어
 * Supabase apply_announcements 에 적재한다.
 *
 * 원칙: "DB에 이미 있는 데이터가 항상 우선". 기존 행을 지우거나 덮어쓰지 않는다.
 * 엑셀 쪽 단지가 DB에 이름+분양월(+지역)으로 이미 존재하면 그 엑셀 행은 건너뛰고,
 * DB에 없는(=엑셀에만 있는) 단지만 새로 추가한다(gap-fill). 청약홈이 5년 넘은
 * 목록을 지워버려도, DB에 이미 확보된 실제 스캔 데이터(수완채리치 같은 — 엑셀엔
 * 없지만 예전에 실제로 크롤된 단지)를 절대 잃지 않기 위함.
 *
 * 공공임대·행복주택·국민주택은 기본적으로 제외(민간임대·일반분양만 적재).
 * 이유: 자격기반 배정이라 "경쟁률" 개념 자체가 약하고, 청약경쟁률 앱에 가치가 낮음.
 * 필요하면 --include-public-rental 로 끌 수 있다.
 *
 * 필요 env (.env): VITE_SUPABASE_URL(또는 SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 *
 * 사용:
 *   # 1) 먼저 파서로 NDJSON 생성(파이썬, openpyxl 필요)
 *   python scripts/legacy/parse_legacy_xlsx.py "<xlsx>" scripts/legacy/legacy_announcements.ndjson
 *   # 2) 적재(수파베이스 연결 후) — 2020-02 이후는 실제 크롤(backfill.mjs)에 맡긴다
 *   node --env-file=.env scripts/ingest-legacy-xlsx.mjs --dry-run --max-month 202001   # 검증만(DB 조회는 하되 쓰기 없음)
 *   node --env-file=.env scripts/ingest-legacy-xlsx.mjs --max-month 202001            # 실제 적재
 */
import { readFileSync } from 'node:fs';
import { getSupabaseAdmin } from '../lib/supabase/serverClient.mjs';
import { matchKey } from './legacy/matchKey.mjs';

const BATCH = 500;
const SELECT_PAGE = 1000;

function parseArgs(argv) {
  const a = {
    file: 'scripts/legacy/legacy_announcements.ndjson',
    dryRun: false, minMonth: null, maxMonth: null, excludePublicRental: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--include-public-rental') a.excludePublicRental = false;
    else if (arg === '--exclude-public-rental') a.excludePublicRental = true; // 하위호환(이제 기본값)
    else if (arg === '--max-month') a.maxMonth = (argv[++i] || '').replace(/[^\d]/g, '').slice(0, 6) || null;
    else if (arg === '--min-month') a.minMonth = (argv[++i] || '').replace(/[^\d]/g, '').slice(0, 6) || null;
    else if (!arg.startsWith('--')) a.file = arg;
  }
  return a;
}

function readNdjson(file, { minMonth, maxMonth, excludePublicRental }) {
  const text = readFileSync(file, 'utf-8');
  const rows = [];
  const now = new Date().toISOString();
  let skippedMonth = 0;
  let skippedRental = 0;
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch (e) {
      throw new Error(`NDJSON ${file}:${i + 1} 파싱 실패: ${e.message}`);
    }
    // 월 범위 필터(문자열 'YYYYMM' 사전식 비교 == 숫자 비교).
    const m = rec.notice_month;
    if (maxMonth && (!m || m > maxMonth)) { skippedMonth += 1; return; }
    if (minMonth && (!m || m < minMonth)) { skippedMonth += 1; return; }
    // 공공임대/행복주택/국민주택 제외(민간임대·일반분양은 유지). detail.houseType 는 파서가 태깅.
    if (excludePublicRental && rec.detail?.houseType === '공공임대') { skippedRental += 1; return; }
    // 적재 시각(멱등 upsert 시 last_crawled_at 갱신). first_crawled_at 은 DB default now().
    rec.last_crawled_at = now;
    rows.push(rec);
  });
  if (skippedMonth) console.log(`  월 범위 필터로 제외: ${skippedMonth}건 (min=${minMonth || '-'}, max=${maxMonth || '-'})`);
  if (skippedRental) console.log(`  공공임대/행복주택/국민주택 제외: ${skippedRental}건`);
  return rows;
}

// DB에 이미 있는 (house_name, notice_month, region) 전체를 페이지 순회로 수집 —
// 로딩 범위(min~maxMonth)로 좁혀서 가져온다. 이름+월(+지역) 매칭 키만 필요하므로
// 가벼운 3컬럼만 select.
async function fetchExistingKeys({ minMonth, maxMonth }) {
  const admin = getSupabaseAdmin();
  const keys = new Set();
  let from = 0;
  for (;;) {
    let q = admin.from('apply_announcements').select('house_name,notice_month,region').range(from, from + SELECT_PAGE - 1);
    if (maxMonth) q = q.lte('notice_month', maxMonth);
    if (minMonth) q = q.gte('notice_month', minMonth);
    const { data, error } = await q;
    if (error) throw new Error(`기존 데이터 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) keys.add(matchKey(r.house_name, r.notice_month, r.region));
    if (data.length < SELECT_PAGE) break;
    from += SELECT_PAGE;
  }
  return keys;
}

async function upsertBatch(rows) {
  const { error } = await getSupabaseAdmin()
    .from('apply_announcements')
    .upsert(rows, { onConflict: 'house_manage_no,pblanc_no' });
  if (error) throw new Error(`upsert 실패: ${error.message}`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const rows = readNdjson(args.file, args);
  console.log(`읽음: ${rows.length} 단지(공고)  ←  ${args.file}`);

  // 간단 무결성 체크.
  const bad = rows.filter((r) => !r.house_manage_no || !r.pblanc_no);
  if (bad.length) {
    console.error(`✗ 키 누락 레코드 ${bad.length}건 — 중단`);
    process.exit(1);
  }
  const keys = new Set(rows.map((r) => `${r.house_manage_no}|${r.pblanc_no}`));
  if (keys.size !== rows.length) {
    console.error(`✗ (house_manage_no,pblanc_no) 중복 ${rows.length - keys.size}건 — 중단`);
    process.exit(1);
  }

  if (!getSupabaseAdmin()) {
    console.error('✗ Supabase 미설정 — .env 에 VITE_SUPABASE_URL(또는 SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY 필요');
    process.exit(1);
  }

  // gap-fill: DB에 이미 있는 단지(이름+분양월+지역)는 건너뛴다 — DB 데이터가 항상 우선.
  console.log('기존 DB 조회 중(gap-fill 대조)…');
  const existing = await fetchExistingKeys(args);
  const toInsert = [];
  let skippedExisting = 0;
  for (const r of rows) {
    if (existing.has(matchKey(r.house_name, r.notice_month, r.region))) { skippedExisting += 1; continue; }
    toInsert.push(r);
  }
  console.log(`  DB에 이미 존재 → 건너뜀: ${skippedExisting}건`);
  console.log(`  신규 추가 대상(엑셀에만 있음): ${toInsert.length}건`);

  if (args.dryRun) {
    const sample = toInsert[0];
    console.log('✓ dry-run: 검증 통과. 신규 추가될 샘플 레코드:');
    console.log(sample ? JSON.stringify({ ...sample, detail: '…(생략)' }, null, 2) : '(신규 추가 대상 없음)');
    process.exit(0);
  }

  let done = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    await upsertBatch(batch);
    done += batch.length;
    console.log(`  upsert ${done}/${toInsert.length}`);
  }
  console.log(`\n✓ 적재 완료 — 신규 ${done}건 추가 (기존 ${skippedExisting}건은 DB 우선으로 유지, source='excel-legacy')`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
