#!/usr/bin/env node
/**
 * 청약 아카이브 일간 동기화 — 청약홈 최근 공고를 Supabase 영구 아카이브에 적재.
 *
 * 청약홈은 ~5년치만 노출하고 시간이 지나면 과거 목록이 사라지므로, 최근 구간을
 * 주기적으로 라이브 크롤해 apply_announcements(+ 스냅샷/상세)에 쌓아둔다.
 * 이렇게 쌓인 아카이브는 검색 API의 1차 소스가 된다(확정 과거 범위는 아카이브
 * 우선 조회, 최신 범위만 라이브 크롤 — lib/applyhome/handlers.mjs).
 *
 * 동작(멱등 — 몇 번 돌려도 안전):
 *   1) 최근 N개월(기본 4: 이번달 포함) 전체 지역 공고를 페이지 순회 크롤
 *   2) 경쟁률 enrich 후 apply_announcements upsert + 당일 스냅샷 적재 (매번 갱신)
 *   3) 상세(일반/특별공급 원본 표) — 모집공고일로부터 REFRESH_WINDOW_DAYS 이내인
 *      공고는 이미 상세가 있어도 매번 재크롤해 덮어쓴다(접수 진행 중/당첨자발표
 *      전후로 접수건수·가점이 계속 바뀌기 때문). 그보다 오래돼 확정된 공고만
 *      상세가 이미 있으면 생략.
 *
 * 필요 env: SUPABASE_URL(또는 VITE_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY
 *
 * 사용:
 *   node --env-file=.env.kb-publish scripts/apply-archive-sync.mjs           # 최근 4개월
 *   node --env-file=.env.kb-publish scripts/apply-archive-sync.mjs --months 6
 *   node scripts/apply-archive-sync.mjs --from 202501 --to 202503            # 명시 범위
 */
import { ApplyHomeCrawler } from '../lib/applyhome/crawler.mjs';
import { archivePage, archiveDetail } from '../lib/applyhome/archive.mjs';
import { getSupabaseAdmin } from '../lib/supabase/serverClient.mjs';

const PAGE_SIZE = 10;
// 모집공고일로부터 이 기간(일) 안에는 접수건수·경쟁률·당첨가점이 계속 바뀔 수 있어
// 상세를 이미 갖고 있어도 매번 재크롤한다. "1개월이면 확정"이라는 기준에 여유를 둔 값.
const REFRESH_WINDOW_DAYS = 35;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ym(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const a = { months: 4, from: null, to: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--months') a.months = Math.max(1, parseInt(argv[++i], 10) || 4);
    else if (argv[i] === '--from') a.from = (argv[++i] ?? '').replace(/[^\d]/g, '').slice(0, 6) || null;
    else if (argv[i] === '--to') a.to = (argv[++i] ?? '').replace(/[^\d]/g, '').slice(0, 6) || null;
  }
  if (!a.from || !a.to) {
    const now = new Date();
    a.to = ym(now);
    const start = new Date(now.getFullYear(), now.getMonth() - (a.months - 1), 1);
    a.from = ym(start);
  }
  return a;
}

// 상세 크롤을 "생략해도 되는" 공고 집합 — 상세가 이미 있고, 모집공고일이
// REFRESH_WINDOW_DAYS 보다 오래돼 결과가 더 이상 안 바뀔 거라 간주되는 것만.
// 최근 공고는 상세가 있어도 이 집합에 넣지 않는다 → 매번 재크롤해 최신값으로 덮어씀.
async function fetchSkippableDetailKeys(startYM, endYM) {
  const sb = getSupabaseAdmin();
  const keys = new Set();
  const { data, error } = await sb
    .from('apply_announcements')
    .select('house_manage_no, pblanc_no, detail, notice_date')
    .gte('notice_month', startYM)
    .lte('notice_month', endYM);
  if (error) throw new Error(`기존 상세 조회 실패: ${error.message}`);
  const cutoff = Date.now() - REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  for (const r of data ?? []) {
    const rows = r.detail?.competition?.rows;
    const hasRows = Array.isArray(rows) && rows.length > 0;
    if (!hasRows) continue; // 상세 자체가 없으면 당연히 재크롤 대상
    const noticeTime = r.notice_date ? new Date(r.notice_date).getTime() : NaN;
    const isFinalized = Number.isFinite(noticeTime) && noticeTime < cutoff;
    if (isFinalized) keys.add(`${r.house_manage_no}:${r.pblanc_no}`);
  }
  return keys;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!getSupabaseAdmin()) {
    console.error('✗ Supabase 미설정 — SUPABASE_URL(또는 VITE_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY 필요');
    process.exit(1);
  }
  console.log(`청약 아카이브 동기화: ${args.from} ~ ${args.to} (전체 지역)`);

  const crawler = new ApplyHomeCrawler();
  const totalCount = await crawler.getTotalCount(args.from, args.to);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  console.log(`  청약홈 목록: ${totalCount}건 · ${totalPages}페이지`);

  // 1) 목록 + 경쟁률 → 아카이브 upsert (페이지 단위)
  const all = [];
  for (let p = 1; p <= totalPages; p += 1) {
    const slice = await crawler.extractApartmentsFromPage(p, args.from, args.to);
    const enriched = await crawler.enrich(slice, 4);
    await archivePage(enriched); // 전체 지역 크롤 — supply_area_code 없음(region 컬럼으로 필터됨)
    all.push(...enriched);
    console.log(`  [목록 ${p}/${totalPages}] ${enriched.length}건 적재 (누적 ${all.length})`);
    await sleep(300); // 차단 회피
  }

  // 2) 확정된(모집공고일 35일 초과) 공고만 상세 생략 — 나머지는 매번 재크롤
  const skippable = await fetchSkippableDetailKeys(args.from, args.to);
  const need = all.filter((a) => !skippable.has(`${a.houseManageNo}:${a.pblancNo || a.houseManageNo}`));
  console.log(`  상세 크롤 대상: ${need.length}건 (확정돼 생략 ${skippable.size}건)`);
  let detailOk = 0;
  for (const a of need) {
    try {
      const detail = await crawler.getApartmentRawDetail({
        houseManageNo: a.houseManageNo,
        pblancNo: a.pblancNo,
        houseName: a.houseName,
      });
      const hasRows = Array.isArray(detail?.competition?.rows) && detail.competition.rows.length > 0;
      if (hasRows || detail?.specialSupply) {
        await archiveDetail(a.houseManageNo, a.pblancNo || a.houseManageNo, detail);
        detailOk += 1;
      }
    } catch (e) {
      console.warn(`  상세 실패(${a.houseManageNo}): ${e.message}`);
    }
    await sleep(150);
  }

  console.log(`\n✓ 동기화 완료 — 목록 ${all.length}건 upsert, 상세 ${detailOk}건 부착`);
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
