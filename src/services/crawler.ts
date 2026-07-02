import { searchComplexes, getArticleList, getComplexesByCortarNo, getArticlesByCortar, getArticleDetail, ComplexItem } from './naverApi';
import { normalizeArticleInfo, normalizeNewLandArticle } from './normalizer';
import { getRegions } from './kbland';
import { randomDelay } from './utils';
import { Property, NAVER_TYPE_MAP, isExclusiveSpaceType, isPresaleType, LogEntry, ProgressInfo, DoneSummary, DongProgress } from '../types';

export type { LogEntry, ProgressInfo, DoneSummary, DongProgress };

// UI realEstateType → new.land.naver.com single-markers API realEstateType 코드 매핑
// Fiddler 캡처 기준: 아파트 검색 시 realEstateType=APT:ABYG 확인
const NEW_LAND_TYPE_MAP: Record<string, string> = {
  'APT:JGC:JGB': 'APT:ABYG',
  'ABYG':        'ABYG',
  'OPST':        'OPST',
  'OBYG':        'OBYG',
  'VL':          'VL',
  'DDDGG':       'DDDGG',
};

// 단지 없이 cortarNo → new.land /api/articles 직접 조회하는 상품유형
const DIRECT_ARTICLE_TYPES = new Set(['VL', 'DDDGG', 'APTHGJ:SMS']);

// UI 코드 → new.land /api/articles realEstateType 파라미터
const DIRECT_TYPE_API_MAP: Record<string, string> = {
  'VL':        'VL:YR:DSD',   // 빌라 + 연립 + 다세대
  'DDDGG':     'DDDGG',
  'APTHGJ:SMS':'APTHGJ:SMS',
};

// new.land 검색 시 Referer (타입별)
const DIRECT_TYPE_REFERER: Record<string, string> = {
  'VL':        'https://new.land.naver.com/houses',
  'DDDGG':     'https://new.land.naver.com/houses',
  'APTHGJ:SMS':'https://new.land.naver.com/offices',
};

export interface CrawlerOptions {
  legalDivisionCode: string;
  legalDivisionName: string;
  tradeType: string;
  realEstateType: string;
  spcMin: number;
  spcMax: number;
  // 지역 계층 정보 — 중지역/소지역 컬럼 표기 + 동 순회 수집용
  midName: string;
  smallName: string;
  midCode: string;        // 중지역 5자리 코드 (동 목록 조회용)
  enumerateDongs: boolean; // true면 중지역 하위 동을 순회 수집
  onLog: (msg: LogEntry) => void;
  onProgress: (progress: ProgressInfo) => void;
  onProperty: (property: Property) => void;
  // 분양권 상세 가격(분양가·프리미엄·옵션) 채워진 뒤 해당 매물을 부분 갱신
  onPropertyPatch: (articleNumber: string, patch: Partial<Property>) => void;
  onDongs: (dongs: DongProgress[]) => void;
  onDone: (summary: DoneSummary) => void;
  onError: (err: string) => void;
}

// 한 번의 cortarNo 단위 수집 대상
interface CrawlTarget {
  cortarNo: string;
  midName: string;
  smallName: string;
  keyword: string;     // 자동완성 폴백 검색어
  enumerated: boolean; // 중지역 하위 동 순회로 만들어진 대상 → 전국 자동완성 폴백 금지
}

// 한 회차 수집 동안 누적되는 상태
interface RunContext {
  passSpace: (p: Property) => boolean;
  isAllSpace: boolean;
  totalProperties: number;
  spaceFilteredOut: number;
  totalComplexes: number;
  dongStates: DongProgress[]; // 사이드바 진행률 시각화용
  // 분양권 가격 보강 대상 (수집 완료 후 상세 API로 분양가/프리미엄/옵션 채움)
  presaleRefs: { articleNumber: string; complexNumber: number }[];
}

function log(onLog: (msg: LogEntry) => void, level: LogEntry['level'], message: string) {
  onLog({ level, message, time: new Date().toISOString() });
}

// KB 법정동코드(2/5/8자리) → Naver cortarNo(10자리)로 0 패딩.
// SearchPanel.getLegalDivisionCode 와 동일 규칙.
function toCortarNo(code: string): string {
  if (code.length === 8) return code + '00';
  if (code.length === 5) return code + '00000';
  if (code.length === 2) return code + '00000000';
  return code;
}

export class CrawlerService {
  private opts: CrawlerOptions;
  private _running = false;
  private _stopRequested = false;
  // 사용자가 건너뛰기 요청한 동 인덱스. 진행 중이면 즉시 중단, 대기 중이면 순회에서 제외.
  private _skippedDongs = new Set<number>();
  // skipDong에서 대기 중 동을 즉시 'skipped'로 반영하기 위한 현재 회차 컨텍스트 참조.
  private _ctx: RunContext | null = null;

  constructor(opts: CrawlerOptions) {
    this.opts = opts;
  }

  isRunning(): boolean {
    return this._running;
  }

  stop(): void {
    this._stopRequested = true;
    this._running = false;
  }

  // 특정 동 건너뛰기 — 진행 중인 동이면 내부 루프가 즉시 빠져나오고, 대기 동이면 순회에서 제외된다.
  skipDong(index: number): void {
    this._skippedDongs.add(index);
    // 대기(pending) 중인 동은 즉시 'skipped'로 표시해 UI에 바로 반영. (active 동은 루프가 종료 후 표시)
    const cur = this._ctx?.dongStates[index];
    if (this._ctx && cur && cur.status === 'pending') {
      this.patchDong(this._ctx, index, { status: 'skipped', pct: 0, indeterminate: false });
    }
  }

  private isSkipped(index: number): boolean {
    return this._skippedDongs.has(index);
  }

  // 동별 진행률 상태를 불변 복사본으로 UI에 전달
  private emitDongs(ctx: RunContext): void {
    this.opts.onDongs(ctx.dongStates.map((d) => ({ ...d })));
  }

  // 현재 동 상태 패치 후 emit
  private patchDong(ctx: RunContext, index: number, patch: Partial<DongProgress>): void {
    const cur = ctx.dongStates[index];
    if (!cur) return;
    ctx.dongStates[index] = { ...cur, ...patch };
    this.emitDongs(ctx);
  }

  // 매물에 중지역/소지역 태깅 후 콜백으로 전달
  private emitProperty(ctx: RunContext, property: Property, target: CrawlTarget): void {
    const tagged: Property = {
      ...property,
      midName: target.midName,
      smallName: target.smallName,
    };
    if (ctx.passSpace(tagged)) {
      this.opts.onProperty(tagged);
      ctx.totalProperties++;
      // 분양권은 목록 API에 가격이 없음 → 수집 완료 후 상세 API로 보강할 대상에 등록.
      // 판정은 검색 상품 유형(opts.realEstateType) 기준 — 목록 API가 주는 개별 매물의
      // realEstateType 표기에 의존하지 않도록 (값이 코드와 다를 수 있음).
      if (isPresaleType(this.opts.realEstateType) && tagged.articleNumber) {
        ctx.presaleRefs.push({
          articleNumber: tagged.articleNumber,
          complexNumber: tagged.complexNumber,
        });
      }
    } else {
      ctx.spaceFilteredOut++;
    }
  }

  // 수집할 cortarNo 대상 목록 결정 (중지역 선택 시 하위 동 순회)
  private async resolveTargets(): Promise<CrawlTarget[]> {
    const { midName, smallName, midCode, enumerateDongs, legalDivisionCode, legalDivisionName } = this.opts;

    if (enumerateDongs && midCode) {
      try {
        const dongs = await getRegions(3, midCode);
        const valid = dongs.filter((d) => d.code && d.name);
        if (valid.length > 0) {
          log(this.opts.onLog, 'info', `🗺️ 중지역 '${midName}' 하위 ${valid.length}개 동 순회 수집`);
          return valid.map((d) => ({
            cortarNo: toCortarNo(d.code),
            midName,
            smallName: d.name,
            keyword: d.name,
            enumerated: true,
          }));
        }
        log(this.opts.onLog, 'warn', `  하위 동 목록이 비어있음 — 중지역 단위로 일괄 수집`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log(this.opts.onLog, 'warn', `  하위 동 목록 조회 실패 (${message}) — 중지역 단위로 일괄 수집`);
      }
    }

    // 폴백/단일: 선택된 cortarNo 그대로 수집
    return [{
      cortarNo: legalDivisionCode,
      midName,
      smallName,
      keyword: legalDivisionName.trim(),
      enumerated: false,
    }];
  }

  async start(): Promise<void> {
    this._running = true;
    this._stopRequested = false;
    this._skippedDongs.clear();
    const startTime = Date.now();
    const { legalDivisionName, realEstateType } = this.opts;

    const naverTypes = NAVER_TYPE_MAP[realEstateType] ?? [];
    if (naverTypes.length === 0 && !DIRECT_ARTICLE_TYPES.has(realEstateType)) {
      const msg = `상품 유형 코드 미확인: ${realEstateType}`;
      log(this.opts.onLog, 'error', msg);
      this.opts.onError(msg);
      this._running = false;
      return;
    }

    const keyword = legalDivisionName.trim();
    if (!keyword) {
      const msg = '지역명이 비어있어 검색할 수 없습니다.';
      log(this.opts.onLog, 'error', msg);
      this.opts.onError(msg);
      this._running = false;
      return;
    }

    const { spcMin, spcMax } = this.opts;
    const filterByExclusive = isExclusiveSpaceType(realEstateType);
    // spcMax=0(미설정) 도 상한 없음으로 처리해 UI 센티넬 비대칭에 안전하도록.
    const lowerBound = spcMin > 0 ? spcMin : 0;
    const upperBound = spcMax > 0 ? spcMax : Number.POSITIVE_INFINITY;
    const isAllSpace = lowerBound <= 0 && !Number.isFinite(upperBound);
    const passSpace = (p: Property): boolean => {
      if (isAllSpace) return true;
      const value = filterByExclusive ? p.exclusiveSpace : p.supplySpace;
      if (value <= 0) return true; // 면적 데이터 미상은 통과 (보수적)
      return value >= lowerBound && value <= upperBound;
    };

    const ctx: RunContext = {
      passSpace,
      isAllSpace,
      totalProperties: 0,
      spaceFilteredOut: 0,
      totalComplexes: 0,
      dongStates: [],
      presaleRefs: [],
    };
    this._ctx = ctx;

    // 수집 대상(동) 목록 결정
    const targets = await this.resolveTargets();
    if (this._stopRequested) {
      this.finish(ctx, startTime, true);
      return;
    }

    const isDirect = DIRECT_ARTICLE_TYPES.has(realEstateType);

    // 모든 동을 pending(0%)으로 먼저 그려 막대가 위에서부터 표시되게 함
    ctx.dongStates = targets.map((t) => ({
      name: t.smallName || t.keyword || this.opts.midName || '전체',
      status: 'pending' as const,
      pct: 0,
      count: 0,
      indeterminate: isDirect,
    }));
    this.emitDongs(ctx);

    for (let t = 0; t < targets.length; t++) {
      if (this._stopRequested) break;
      const target = targets[t];
      if (!target.cortarNo) continue;

      // 시작 전 이미 건너뛰기 요청된 동은 수집하지 않고 'skipped'로 표시
      if (this.isSkipped(t)) {
        this.patchDong(ctx, t, { status: 'skipped', pct: 0, indeterminate: false });
        log(this.opts.onLog, 'info', `⏭️ ${target.smallName || target.keyword} 건너뜀`);
        continue;
      }

      // 동 순회 시 진행 표시
      if (targets.length > 1) {
        log(
          this.opts.onLog,
          'info',
          `📍 [${t + 1}/${targets.length}] ${target.smallName} 수집 시작 (cortarNo: ${target.cortarNo})`,
        );
      }

      if (isDirect) {
        await this.crawlDirectTarget(ctx, target, t);
      } else {
        await this.crawlComplexTarget(ctx, target, t, naverTypes);
      }

      // 동 간 딜레이 (차단 회피)
      if (t < targets.length - 1 && !this._stopRequested) {
        await randomDelay(1000, 3000);
      }
    }

    // 분양권 가격 보강 — '완료' 처리 전에 끝내 결과창에 가격이 모두 채워진 상태로 완료되게 함
    await this.enrichPresalePrices(ctx);

    this.finish(ctx, startTime, this._stopRequested);
  }

  // 분양권(ABYG/OBYG)은 목록 API에 분양가/프리미엄/옵션이 없으므로
  // 수집 완료 직후 new.land 상세 API로 매물별 가격을 채운다. (차단 회피용 순차 + 딜레이)
  // → 단지 수집(1차 바) 완료 후 별도 2차 진행바를 추가해 진행 상황을 표시한다.
  private async enrichPresalePrices(ctx: RunContext): Promise<void> {
    const refs = ctx.presaleRefs;
    if (refs.length === 0 || this._stopRequested) return;

    const total = refs.length;

    // 2차 진행바(분양권 가격 조회) 추가 — 배너 표시는 CrawlProgressPanel이 phase로 판단
    const presaleIndex = ctx.dongStates.length;
    ctx.dongStates.push({
      name: '개별 분양권 가격 조회',
      status: 'pending',
      pct: 0,
      count: 0,
      phase: 'presale-price',
    });
    this.emitDongs(ctx);

    log(this.opts.onLog, 'info', `💰 분양권 가격 정보 수집 시작 (${total}건)…`);
    this.patchDong(ctx, presaleIndex, { status: 'active' });

    for (let i = 0; i < total; i++) {
      if (this._stopRequested) {
        this.patchDong(ctx, presaleIndex, { status: 'skipped' });
        return;
      }
      const { articleNumber, complexNumber } = refs[i];
      try {
        const detail = await getArticleDetail(
          articleNumber,
          complexNumber > 0 ? complexNumber : undefined,
        );
        if (detail) {
          this.opts.onPropertyPatch(articleNumber, {
            isalePrice: detail.isalePrice,
            premiumPrice: detail.premiumPrice,
            optionPrice: detail.optionPrice,
          });
        }
      } catch {
        // 개별 매물 실패는 무시 (가격은 '-'로 표시됨)
      }

      const pct = Math.round(((i + 1) / total) * 100);
      this.patchDong(ctx, presaleIndex, { pct, count: i + 1 });

      // 로그 갱신 (10건마다 + 마지막)
      if ((i + 1) % 10 === 0 || i + 1 === total) {
        log(this.opts.onLog, 'info', `💰 분양권 가격 정보 수집 중… (${i + 1}/${total})`);
        this.opts.onProgress({
          phase: 'crawl',
          current: i + 1,
          total,
          complexName: '가격 정보 수집',
          propertyCount: ctx.totalProperties,
        });
      }

      if (i < total - 1) await randomDelay(150, 400);
    }

    this.patchDong(ctx, presaleIndex, { status: 'done', pct: 100, count: total });
    log(this.opts.onLog, 'success', `💰 분양권 가격 정보 수집 완료 (${total}건)`);
  }

  private finish(ctx: RunContext, startTime: number, stopped: boolean): void {
    const duration = Date.now() - startTime;
    if (!stopped) {
      const filterNote = !ctx.isAllSpace ? `, 면적 필터 제외 ${ctx.spaceFilteredOut}건` : '';
      const complexNote = ctx.totalComplexes > 0 ? `${ctx.totalComplexes}개 단지, ` : '';
      log(
        this.opts.onLog,
        'success',
        `🎉 크롤링 완료: ${complexNote}${ctx.totalProperties}건 매물${filterNote}, ${Math.round(duration / 1000)}초 소요`,
      );
    }
    this._running = false;
    this._ctx = null;
    this.opts.onDone({
      totalComplexes: ctx.totalComplexes,
      totalProperties: ctx.totalProperties,
      duration,
    });
  }

  // ─── VL/DDDGG/SMS/APTHGJ: 단지 없이 cortarNo 직접 매물 조회 ───
  // 총량 미상 → indeterminate 펄스로 진행, 누적 건수 실시간 표시. 종료 시 100% 스냅.
  private async crawlDirectTarget(ctx: RunContext, target: CrawlTarget, dongIndex: number): Promise<void> {
    const { realEstateType, tradeType } = this.opts;
    const apiType = DIRECT_TYPE_API_MAP[realEstateType] ?? realEstateType;
    const referer = DIRECT_TYPE_REFERER[realEstateType];
    const baseline = ctx.totalProperties;
    let page = 1;
    let hasMore = true;

    log(this.opts.onLog, 'info', `🔍 ${target.smallName || target.keyword} 매물 직접 검색 (cortarNo: ${target.cortarNo})`);
    // 총량 미상이라 페이지 진행에 따라 점진적으로 차오르게(상한 90%), 완료 시 100% 스냅.
    this.patchDong(ctx, dongIndex, { status: 'active', indeterminate: true, pct: 6 });

    while (hasMore && !this._stopRequested && !this.isSkipped(dongIndex)) {
      try {
        const result = await getArticlesByCortar(target.cortarNo, apiType, tradeType, page, referer);

        for (const article of result.list) {
          this.emitProperty(ctx, normalizeNewLandArticle(article), target);
        }

        hasMore = result.hasNextPage;
        this.opts.onProgress({ phase: 'crawl', current: page, total: page, propertyCount: ctx.totalProperties });
        this.patchDong(ctx, dongIndex, {
          count: ctx.totalProperties - baseline,
          pct: Math.min(90, page * 14),
        });
        log(this.opts.onLog, 'info', `  페이지 ${page}: ${result.list.length}건 수집 (누적: ${ctx.totalProperties}건)`);
        page++;
        if (hasMore) await randomDelay(500, 1500);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log(this.opts.onLog, 'error', `매물 수집 오류: ${message}`);
        if (/429/.test(message)) {
          log(this.opts.onLog, 'error', '⚠ Naver가 요청을 잠시 제한했습니다(429). 재로그인은 필요 없습니다 — 잠시 후 다시 시도하면 자동 재시도됩니다. 계속되면 네이버에 로그인하면 완화될 수 있습니다.');
        }
        break;
      }
    }

    if (this.isSkipped(dongIndex)) {
      this.patchDong(ctx, dongIndex, {
        status: 'skipped',
        indeterminate: false,
        count: ctx.totalProperties - baseline,
      });
      log(this.opts.onLog, 'info', `⏭️ ${target.smallName || target.keyword} 건너뜀 (수집 ${ctx.totalProperties - baseline}건까지)`);
      return;
    }

    this.patchDong(ctx, dongIndex, {
      status: 'done',
      pct: 100,
      indeterminate: false,
      count: ctx.totalProperties - baseline,
    });
  }

  // ─── APT 등: cortarNo 기반 단지 목록 → 단지별 매물 수집 ───
  private async crawlComplexTarget(ctx: RunContext, target: CrawlTarget, dongIndex: number, naverTypes: string[]): Promise<void> {
    const { realEstateType, tradeType, spcMin, spcMax } = this.opts;
    const naverTypeSet = new Set(naverTypes);
    const complexes: ComplexItem[] = [];
    const keyword = target.keyword;
    const baseline = ctx.totalProperties;

    this.patchDong(ctx, dongIndex, { status: 'active' });

    // ─── Phase 1: cortarNo 기반 단지 목록 수집 ───
    log(this.opts.onLog, 'info', `🔍 단지 검색 시작: "${keyword}"`);

    let usedCortarNo = false;
    if (target.cortarNo && !this._stopRequested) {
      try {
        const newLandType = NEW_LAND_TYPE_MAP[realEstateType] ?? realEstateType;
        const items = await getComplexesByCortarNo(target.cortarNo, newLandType, tradeType, spcMin, spcMax);
        if (items.length > 0) {
          for (const item of items) {
            complexes.push({
              complexNumber: item.complexNumber,
              complexName: item.complexName,
              type: naverTypes[0] ?? '',
              legalDivisionName: keyword,
              coordinates: { xCoordinate: 0, yCoordinate: 0 },
            });
          }
          usedCortarNo = true;
          log(this.opts.onLog, 'success', `✅ cortarNo(${target.cortarNo}) 기반으로 ${complexes.length}개 단지 수집`);
        } else {
          log(this.opts.onLog, 'warn', `  cortarNo 검색 결과 없음 — 자동완성 API로 전환`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log(this.opts.onLog, 'warn', `  cortarNo 검색 실패 (${message}) — 자동완성 API로 전환`);
      }
    }

    // ─── Phase 1 폴백: searchComplexes 자동완성 API ───
    // ⚠️ 동 순회(enumerated) 대상은 전국 자동완성 폴백을 절대 사용하지 않는다.
    //    자동완성은 keyword 부분일치(legalDivisionName.includes)로 동작하므로,
    //    "금동" 같은 동명이 "서울 송파구 오금동" 등 전국의 ~금동까지 끌어와 교차오염을 일으킨다.
    //    순회 시 cortarNo가 절대 기준이므로, 단지 0건이면 그 동은 진짜 0건으로 처리한다.
    const AUTOCOMPLETE_MAX_PAGES = 20; // 최대 400건 스캔
    if (!usedCortarNo && !this._stopRequested && keyword && target.enumerated) {
      log(
        this.opts.onLog,
        'info',
        `  ${target.smallName || keyword}: cortarNo 기준 단지 0건 — 전국 검색 생략(교차오염 방지)`,
      );
    }
    if (!usedCortarNo && !this._stopRequested && keyword && !target.enumerated) {
      let page = 0;
      let hasNextPage = true;
      let consecutiveEmptyPages = 0;

      while (hasNextPage && !this._stopRequested && page < AUTOCOMPLETE_MAX_PAGES) {
        try {
          const result = await searchComplexes(keyword, page, 20);
          const filtered = result.list.filter(
            (c) => c.legalDivisionName.includes(keyword) && naverTypeSet.has(c.type),
          );
          complexes.push(...filtered);
          hasNextPage = result.hasNextPage;

          log(
            this.opts.onLog,
            'info',
            `  단지 ${complexes.length}건 수집 (페이지 ${page + 1}/${AUTOCOMPLETE_MAX_PAGES}, 이번 ${filtered.length}건)`,
          );

          if (filtered.length === 0) {
            consecutiveEmptyPages++;
            if (consecutiveEmptyPages >= 3) {
              log(this.opts.onLog, 'info', '  관련 단지 수집 완료 (연속 빈 페이지 도달)');
              break;
            }
          } else {
            consecutiveEmptyPages = 0;
          }

          page++;
          if (hasNextPage) await randomDelay(500, 1500);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log(this.opts.onLog, 'error', `단지 검색 오류: ${message}`);
          if (/429/.test(message)) {
            log(
              this.opts.onLog,
              'error',
              '⚠ Naver가 익명 호출을 거부 중입니다. [설정] 탭에서 fin.land.naver.com 의 최신 Cookie를 붙여넣고 다시 시도해 주세요.',
            );
          }
          break;
        }
      }
    }

    if (this._stopRequested) return;

    ctx.totalComplexes += complexes.length;
    log(this.opts.onLog, 'success', `✅ ${target.smallName || keyword}: ${complexes.length}개 단지 수집 완료`);

    // 단지가 없으면 즉시 완료 처리
    if (complexes.length === 0) {
      this.patchDong(ctx, dongIndex, { status: 'done', pct: 100, count: ctx.totalProperties - baseline });
      return;
    }

    // ─── Phase 2: 각 단지별 매물 수집 ───
    for (let i = 0; i < complexes.length; i++) {
      if (this._stopRequested || this.isSkipped(dongIndex)) break;

      const complex = complexes[i];
      log(
        this.opts.onLog,
        'info',
        `📦 [${i + 1}/${complexes.length}] ${complex.complexName} (${complex.complexNumber}) 매물 수집 중...`,
      );

      this.opts.onProgress({
        phase: 'crawl',
        current: i + 1,
        total: complexes.length,
        complexName: complex.complexName,
        propertyCount: ctx.totalProperties,
      });

      let artHasNext = true;
      let lastInfoCursor: unknown[] = [];

      while (artHasNext && !this._stopRequested && !this.isSkipped(dongIndex)) {
        try {
          const artResult = await getArticleList({
            complexNumber: complex.complexNumber,
            tradeTypes: [tradeType],
            lastInfoCursor,
            size: 20,
          });

          for (const item of artResult.list) {
            const mainInfo = item.representativeArticleInfo;
            const dupList = item.duplicatedArticleInfo?.articleInfoList ?? [];
            const realtorCount = item.duplicatedArticleInfo?.realtorCount ?? 1;
            const hasActualDups = dupList.length > 0;

            const property = normalizeArticleInfo(
              mainInfo,
              complex.complexNumber,
              realtorCount,
              complex.complexName,
            );
            if (hasActualDups) property.groupId = mainInfo.articleNumber;
            property.isDuplicate = false;
            this.emitProperty(ctx, property, target);

            // 중복 하위 매물 수집 (같은 unit의 다른 중개사 등록)
            for (const dupInfo of dupList) {
              const dupProp = normalizeArticleInfo(dupInfo, complex.complexNumber, 1, complex.complexName);
              dupProp.groupId = mainInfo.articleNumber;
              dupProp.isDuplicate = true;
              this.emitProperty(ctx, dupProp, target);
            }
          }

          artHasNext = artResult.hasNextPage;
          lastInfoCursor = artResult.lastInfo ?? [];

          if (artHasNext) await randomDelay(500, 1500);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log(
            this.opts.onLog,
            'warn',
            `  ⚠️ ${complex.complexName} 매물 오류: ${message} — 스킵`,
          );
          break;
        }
      }

      log(this.opts.onLog, 'info', `  → 누적 매물: ${ctx.totalProperties}건`);

      // 동 진행률: 완료 단지 / 전체 단지
      this.patchDong(ctx, dongIndex, {
        pct: Math.round(((i + 1) / complexes.length) * 100),
        count: ctx.totalProperties - baseline,
      });

      if (i < complexes.length - 1 && !this._stopRequested && !this.isSkipped(dongIndex)) {
        await randomDelay(1000, 3000);
      }
    }

    if (this.isSkipped(dongIndex)) {
      this.patchDong(ctx, dongIndex, {
        status: 'skipped',
        count: ctx.totalProperties - baseline,
      });
      log(this.opts.onLog, 'info', `⏭️ ${target.smallName || keyword} 건너뜀 (수집 ${ctx.totalProperties - baseline}건까지)`);
      return;
    }

    this.patchDong(ctx, dongIndex, {
      status: 'done',
      pct: 100,
      count: ctx.totalProperties - baseline,
    });
  }
}
