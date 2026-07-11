import { Property, DIRECTION_LABELS, TRADE_TYPE_LABELS, isExclusiveSpaceType, isPresaleType, SavedSlot, SearchMeta } from '../types';
import { ArticleDetailResult } from './naverApi';
import ExcelJS from 'exceljs';

// =============================================
// 공개 유틸
// =============================================
export type PriceUnit = 'thousand' | 'manwon';
export type AreaUnit = 'sqm' | 'pyeong';

const SQM_TO_PYEONG = 0.3025;
const round2 = (v: number): number => Math.round(v * 100) / 100;

export function cleanBrokerageName(name: string): string {
  return name
    .replace(/\s*공인중개사사무소\s*$/, '')  // 공인중개사 + 사무소 (정식 표기)
    .replace(/\s*공인중개사무소\s*$/,  '')   // 공인중개 + 사무소 (약어 표기)
    .trim();
}

// 방향 코드 → 한글, 후행 "향" 제거 (예: 서북향 → 서북, 남향 → 남)
export function formatDirection(direction: string): string {
  return (DIRECTION_LABELS[direction] ?? direction).replace(/향$/, '');
}

// =============================================
// 가격 단위 변환 (Excel 숫자용)
// dealPrice / warrantyPrice / rentPrice: 모두 원 단위 저장
// =============================================
function toPriceUnit(rawPriceWon: number, unit: PriceUnit): number {
  return unit === 'thousand' ? Math.round(rawPriceWon / 1000) : Math.round(rawPriceWon / 10000);
}

// 수집 결과 표시용: 선택 단위(천원/만원)로 변환한 숫자에 천단위 콤마. 0은 '-'.
export function formatPriceByUnit(rawPriceWon: number, unit: PriceUnit): string {
  if (rawPriceWon <= 0) return '-';
  return toPriceUnit(rawPriceWon, unit).toLocaleString();
}

// 분양권 프리미엄 전용 — 마이너스 프리미엄(P가 음수)도 표기한다.
// 0 은 '미상/해당없음'으로 보고 '-' 처리, 그 외(음수 포함)는 부호와 함께 표기.
export function formatPremiumByUnit(rawPriceWon: number, unit: PriceUnit): string {
  if (rawPriceWon === 0) return '-';
  return toPriceUnit(rawPriceWon, unit).toLocaleString();
}

// 평당가(원/평) 계산: 매매(A1)만 의미. 아파트=공급면적, 오피스텔/상가/지산=전용면적 기준.
// 해당 없으면 0 반환.
export function pyeongUnitPriceWon(p: Property, realEstateType: string): number {
  if (p.tradeType !== 'A1' || p.dealPrice <= 0) return 0;
  const areaSqm = isExclusiveSpaceType(realEstateType) ? p.exclusiveSpace : p.supplySpace;
  if (areaSqm <= 0) return 0;
  const pyeong = areaSqm * SQM_TO_PYEONG;
  return pyeong > 0 ? p.dealPrice / pyeong : 0;
}

// =============================================
// Excel 내보내기
// =============================================

type DetailMap = Map<string, ArticleDetailResult | 'loading' | 'error'>;

function resolveDetail(map: DetailMap | undefined, articleNumber: string): ArticleDetailResult | null {
  if (!map) return null;
  const v = map.get(articleNumber);
  return (v && v !== 'loading' && v !== 'error') ? v : null;
}

// 워크북에 매물 시트 1개 추가 (단일 내보내기 / 슬롯별 시트 분리 공용)
function addPropertiesWorksheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  properties: Property[],
  priceUnit: PriceUnit,
  areaUnit: AreaUnit,
  realEstateType: string,
  detailMap?: DetailMap,
): void {
  const worksheet = workbook.addWorksheet(sheetName);

  const unitLabel      = priceUnit === 'thousand' ? '천원' : '만원';
  const useContract    = isExclusiveSpaceType(realEstateType);
  const isPresale      = isPresaleType(realEstateType);
  const presaleUseExcl = realEstateType === 'OBYG';
  const u              = areaUnit === 'pyeong' ? '평' : '㎡';
  const toUnit         = (sqm: number) => (areaUnit === 'pyeong' ? round2(sqm * SQM_TO_PYEONG) : sqm);
  const secondSqm      = (p: Property) =>
    useContract ? (p.contractSpace > 0 ? p.contractSpace : p.supplySpace) : p.supplySpace;
  const hasA1          = properties.some((p) => p.tradeType === 'A1');
  const hasB           = properties.some((p) => p.tradeType === 'B1' || p.tradeType === 'B2');
  const hasB2          = properties.some((p) => p.tradeType === 'B2');

  type ColSpec = { header: string; key: string; width: number };

  const cols: ColSpec[] = [
    { header: '중지역', key: 'midName',         width: 10 },
    { header: '소지역', key: 'smallName',        width: 10 },
    { header: '거래',   key: 'tradeType',        width: 8  },
    { header: '단지명', key: 'complexName',      width: 30 },
    { header: '동',     key: 'dongName',         width: 10 },
    { header: '층',     key: 'floorInfo',        width: 10 },
    { header: '방향',   key: 'direction',        width: 10 },
    { header: '타입',   key: 'supplySpaceName',  width: 10 },
  ];

  cols.push({ header: `전용(${u})`,                     key: 'exclusiveArea', width: 10 });
  cols.push({ header: `${useContract ? '계약' : '공급'}(${u})`, key: 'secondArea',   width: 10 });

  if (!isPresale && hasA1) {
    cols.push({ header: `매매가(${unitLabel})`, key: 'dealPrice',   width: 10 });
    cols.push({ header: `평당가(${unitLabel})`, key: 'pyeongPrice', width: 10 });
  }
  if (isPresale) {
    cols.push({ header: `분양가(${unitLabel})`,         key: 'isalePrice',      width: 10 });
    cols.push({ header: `평당가(분양)(${unitLabel})`,   key: 'isalePyeong',     width: 10 });
    cols.push({ header: `P(${unitLabel})`,              key: 'premiumPrice',    width: 10 });
    cols.push({ header: `옵션비용(${unitLabel})`,       key: 'optionPrice',     width: 10 });
    cols.push({ header: `매매가(${unitLabel})`,         key: 'totalBuyPrice',   width: 10 });
    cols.push({ header: `평당가(분양권)(${unitLabel})`, key: 'realPyeongPrice', width: 10 });
  }
  if (hasB)  cols.push({ header: `보증금(${unitLabel})`, key: 'warrantyPrice', width: 10 });
  if (hasB2) cols.push({ header: `월세(${unitLabel})`,   key: 'rentPrice',     width: 10 });

  cols.push({ header: '특징', key: 'articleFeature', width: 70 });
  if (detailMap) cols.push({ header: '상세특징', key: 'detailDescription', width: 100 });
  cols.push({ header: '중개업소', key: 'brokerageName', width: 30 });
  if (detailMap) {
    // 업소명은 중개업소와 동일한 내용이므로 제외
    cols.push(
      { header: '주소',     key: 'realtorAddress',     width: 30 },
      { header: '연락처1',  key: 'cellPhoneNo',        width: 15 },
      { header: '연락처2',  key: 'representativeTelNo', width: 15 },
      { header: '매매매물', key: 'realtorDealCount',   width: 10 },
      { header: '전세매물', key: 'realtorLeaseCount',  width: 10 },
      { header: '월세매물', key: 'realtorRentCount',   width: 10 },
    );
  }

  worksheet.columns = cols;

  // 헤더 스타일: 전체 중앙정렬
  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font      = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  headerRow.height = 20;

  // 자동 필터
  const lastColLetter = worksheet.getColumn(cols.length).letter;
  worksheet.autoFilter = { from: 'A1', to: `${lastColLetter}1` };

  const LEFT_KEYS = new Set(['articleFeature', 'detailDescription', 'brokerageName', 'realtorAddress']);
  const NUM_KEYS  = new Set(['dealPrice', 'pyeongPrice', 'warrantyPrice', 'rentPrice', 'isalePrice', 'isalePyeong', 'premiumPrice', 'optionPrice', 'totalBuyPrice', 'realPyeongPrice']);
  const AREA_KEYS = new Set(['exclusiveArea', 'secondArea']);

  for (const p of properties) {
    const secondVal     = secondSqm(p);
    const presaleArea   = presaleUseExcl ? p.exclusiveSpace : p.supplySpace;
    const presalePyeong = presaleArea * SQM_TO_PYEONG;
    const totalBuy      = p.isalePrice + p.premiumPrice + p.optionPrice;
    const realPyeongPr  = presalePyeong > 0 && totalBuy > 0 ? totalBuy / presalePyeong : 0;
    const detail        = resolveDetail(detailMap, p.articleNumber);

    const rowData: Record<string, string | number | null> = {
      midName:             p.midName         || '-',
      smallName:           p.smallName       || '-',
      tradeType:           TRADE_TYPE_LABELS[p.tradeType] ?? p.tradeType,
      complexName:         p.complexName     || '-',
      dongName:            p.dongName        || '-',
      floorInfo:           p.floorInfo       || '-',
      direction:           formatDirection(p.direction) || '-',
      supplySpaceName:     p.supplySpaceName || '-',
      exclusiveArea:       p.exclusiveSpace > 0 ? toUnit(p.exclusiveSpace) : null,
      secondArea:          secondVal > 0 ? toUnit(secondVal) : null,
      articleFeature:      p.articleFeature  || '-',
      detailDescription:   detail?.detailDescription || null,
      brokerageName:       cleanBrokerageName(p.brokerageName) || '-',
      realtorAddress:      detail?.realtorAddress     || null,
      cellPhoneNo:         detail?.cellPhoneNo        || null,
      representativeTelNo: detail?.representativeTelNo || null,
      realtorDealCount:    detail != null ? detail.dealCount  : null,
      realtorLeaseCount:   detail != null ? detail.leaseCount : null,
      realtorRentCount:    detail != null ? detail.rentCount  : null,
    };

    if (!isPresale && hasA1) {
      rowData.dealPrice = p.tradeType === 'A1' && p.dealPrice > 0
        ? toPriceUnit(p.dealPrice, priceUnit) : null;
      const pyeongWon = pyeongUnitPriceWon(p, realEstateType);
      rowData.pyeongPrice = pyeongWon > 0 ? toPriceUnit(pyeongWon, priceUnit) : null;
    }
    if (isPresale) {
      rowData.isalePrice     = p.isalePrice > 0   ? toPriceUnit(p.isalePrice, priceUnit)   : null;
      rowData.isalePyeong    = presalePyeong > 0 && p.isalePrice > 0
        ? toPriceUnit(p.isalePrice / presalePyeong, priceUnit) : null;
      rowData.premiumPrice   = p.premiumPrice !== 0 ? toPriceUnit(p.premiumPrice, priceUnit) : null;
      rowData.optionPrice    = p.optionPrice > 0  ? toPriceUnit(p.optionPrice, priceUnit)   : null;
      rowData.totalBuyPrice  = totalBuy > 0       ? toPriceUnit(totalBuy, priceUnit)        : null;
      rowData.realPyeongPrice = realPyeongPr > 0  ? toPriceUnit(realPyeongPr, priceUnit)   : null;
    }
    if (hasB) {
      rowData.warrantyPrice = (p.tradeType === 'B1' || p.tradeType === 'B2') && p.warrantyPrice > 0
        ? toPriceUnit(p.warrantyPrice, priceUnit) : null;
    }
    if (hasB2) {
      rowData.rentPrice = p.tradeType === 'B2' && p.rentPrice > 0
        ? toPriceUnit(p.rentPrice, priceUnit) : null;
    }

    const row = worksheet.addRow(rowData);
    row.height = 16.5; // 내용 길이와 무관하게 행 높이 고정

    for (let i = 1; i <= cols.length; i++) {
      const key  = cols[i - 1].key;
      const cell = row.getCell(i);

      cell.alignment = {
        horizontal: LEFT_KEYS.has(key) ? 'left' : 'center',
        vertical:   'middle',
      };

      if (NUM_KEYS.has(key) && typeof cell.value === 'number') {
        cell.numFmt = '#,##0';
      } else if (AREA_KEYS.has(key) && typeof cell.value === 'number') {
        cell.numFmt = '#,##0.##';
      }
    }
  }
}

// 워크북을 .xlsx 파일로 다운로드
async function downloadWorkbook(workbook: ExcelJS.Workbook, filename: string): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Excel에서 금지된 시트명 문자 제거 + 31자 제한
function sanitizeSheetName(name: string): string {
  const clean = name.replace(/[\\/?*[\]:]/g, ' ').trim() || '시트';
  return clean.slice(0, 31);
}

// 윈도우/맥에서 금지된 파일명 문자 제거
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 내보내기 파일명(확장자 제외) 생성
// 예: "2026.06.17 전북특별자치도 군산시 - 84타입 매매매물 1,941건"
export function buildExportBaseName(meta: SearchMeta, count: number): string {
  const now = new Date();
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;

  const parts = [meta.largeName, meta.midName, meta.smallName].map((s) => (s ?? '').trim()).filter(Boolean);
  // 연속 중복 제거 (예: 세종특별자치시처럼 대지역명=중지역명인 경우)
  const region = parts.filter((p, i) => i === 0 || p !== parts[i - 1]).join(' ') || '검색결과';

  const trade = TRADE_TYPE_LABELS[meta.tradeType] ?? meta.tradeType ?? '';
  const area = (meta.areaLabel ?? '').trim();
  const areaPart = area ? `${area} ` : '';

  return sanitizeFileName(`${date} ${region} - ${areaPart}${trade}매물 ${count.toLocaleString()}건`);
}

export async function exportExcel(
  properties: Property[],
  priceUnit: PriceUnit,
  areaUnit: AreaUnit = 'sqm',
  realEstateType = '',
  filenameBase?: string,
  detailMap?: DetailMap,
): Promise<void> {
  if (properties.length === 0) return;
  const workbook = new ExcelJS.Workbook();
  addPropertiesWorksheet(workbook, '매물', properties, priceUnit, areaUnit, realEstateType, detailMap);
  const name = filenameBase ? `${filenameBase}.xlsx` : `listings_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await downloadWorkbook(workbook, name);
}

// 여러 슬롯을 슬롯별 시트로 분리해 하나의 엑셀로 내보내기
export async function exportSlotsExcel(
  slots: SavedSlot[],
  priceUnit: PriceUnit,
  areaUnit: AreaUnit = 'sqm',
): Promise<void> {
  const valid = slots.filter((s) => s.properties.length > 0);
  if (valid.length === 0) return;

  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set<string>();

  valid.forEach((slot, idx) => {
    const region = slot.meta.smallName
      ? `${slot.meta.midName} ${slot.meta.smallName}`
      : (slot.meta.midName || slot.meta.largeName);
    let base = sanitizeSheetName(`${idx + 1}_${region}`);
    // 시트명 중복 방지
    let name = base;
    let dup = 2;
    while (usedNames.has(name)) {
      name = sanitizeSheetName(`${base} (${dup++})`);
    }
    usedNames.add(name);
    addPropertiesWorksheet(workbook, name, slot.properties, priceUnit, areaUnit, slot.meta.realEstateType);
  });

  await downloadWorkbook(workbook, `listing_slots_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// =============================================
// JSON 내보내기
// =============================================
export function exportJSON(properties: Property[], filenameBase?: string, detailMap?: DetailMap): void {
  if (properties.length === 0) return;
  const data = detailMap
    ? properties.map((p) => {
        const detail = resolveDetail(detailMap, p.articleNumber);
        return detail ? {
          ...p,
          detailDescription:   detail.detailDescription,
          realtorName:         detail.realtorName,
          realtorAddress:      detail.realtorAddress,
          cellPhoneNo:         detail.cellPhoneNo,
          representativeTelNo: detail.representativeTelNo,
          realtorDealCount:    detail.dealCount,
          realtorLeaseCount:   detail.leaseCount,
          realtorRentCount:    detail.rentCount,
        } : p;
      })
    : properties;
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filenameBase ? `${filenameBase}.json` : `listings_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportMarkdown(
  properties: Property[],
  priceUnit: PriceUnit,
  areaUnit: AreaUnit = 'sqm',
  realEstateType = '',
  filenameBase?: string,
  detailMap?: DetailMap,
): void {
  if (properties.length === 0) return;
  const useContract = isExclusiveSpaceType(realEstateType);
  const hasA1 = properties.some((p) => p.tradeType === 'A1');
  const hasB  = properties.some((p) => p.tradeType === 'B1' || p.tradeType === 'B2');
  const hasB2 = properties.some((p) => p.tradeType === 'B2');
  const isPresale = realEstateType === 'ABYG' || realEstateType === 'OBYG';
  const u = areaUnit === 'pyeong' ? '평' : '㎡';
  const unitLabel = priceUnit === 'thousand' ? '천원' : '만원';
  const sqmToPy = 0.3025;
  const fmt = (sqm: number) => areaUnit === 'pyeong' ? `${(sqm * sqmToPy).toFixed(2)}평` : `${sqm}㎡`;

  const headers: string[] = ['지역', '거래', '단지명', '동', '층', '방향', '타입',
    `전용(${u})`, `${useContract ? '계약' : '공급'}(${u})`];
  if (hasA1)     { headers.push(`매매가(${unitLabel})`, `평당가(${unitLabel})`); }
  if (isPresale) { headers.push(`분양가(${unitLabel})`, `프리미엄(${unitLabel})`, `옵션비용(${unitLabel})`, `매수비용(${unitLabel})`, `실평당가(${unitLabel})`); }
  if (hasB)      headers.push(`보증금(${unitLabel})`);
  if (hasB2)     headers.push(`월세(${unitLabel})`);
  headers.push('특징');
  if (detailMap) headers.push('상세특징');
  headers.push('중개업소');
  if (detailMap) headers.push('업소명', '주소', '연락처1', '연락처2', '매매매물', '전세매물', '월세매물');

  const sep = headers.map(() => '---').join(' | ');
  const headerRow = headers.join(' | ');

  const rows = properties.map((p) => {
    const area = isExclusiveSpaceType(realEstateType) ? p.exclusiveSpace : p.supplySpace;
    const pyeong = area * sqmToPy;
    const pyeongPrice = pyeong > 0 && p.tradeType === 'A1' ? Math.round(p.dealPrice / pyeong) : 0;
    const totalBuy = p.isalePrice + p.premiumPrice + p.optionPrice;
    const realPP = pyeong > 0 && totalBuy > 0 ? Math.round(totalBuy / pyeong) : 0;

    const cells: string[] = [
      `${p.midName} ${p.smallName}`.trim() || '-',
      TRADE_TYPE_LABELS[p.tradeType] ?? p.tradeType,
      p.complexName || '-',
      p.dongName || '-',
      p.floorInfo || '-',
      (DIRECTION_LABELS[p.direction] ?? p.direction).replace(/향$/, '') || '-',
      p.supplySpaceName || '-',
      fmt(p.exclusiveSpace),
      fmt(useContract ? (p.contractSpace > 0 ? p.contractSpace : p.supplySpace) : p.supplySpace),
    ];
    if (hasA1) {
      cells.push(
        p.tradeType === 'A1' ? toPriceUnitStr(p.dealPrice, priceUnit) : '-',
        p.tradeType === 'A1' && pyeongPrice > 0 ? toPriceUnitStr(p.dealPrice, priceUnit, pyeong) : '-',
      );
    }
    if (isPresale) {
      cells.push(
        p.isalePrice > 0 ? formatPriceByUnit(p.isalePrice, priceUnit) : '-',
        formatPremiumByUnit(p.premiumPrice, priceUnit),
        p.optionPrice > 0 ? formatPriceByUnit(p.optionPrice, priceUnit) : '-',
        totalBuy > 0 ? formatPriceByUnit(totalBuy, priceUnit) : '-',
        realPP > 0 ? formatPriceByUnit(realPP, priceUnit) : '-',
      );
    }
    if (hasB)  cells.push((p.tradeType === 'B1' || p.tradeType === 'B2') ? formatPriceByUnit(p.warrantyPrice, priceUnit) : '-');
    if (hasB2) cells.push(p.tradeType === 'B2' ? formatPriceByUnit(p.rentPrice, priceUnit) : '-');

    const esc = (s: string) => (s || '-').replace(/\|/g, '∣').replace(/\n/g, ' ');
    cells.push(esc(p.articleFeature));
    if (detailMap) {
      const detail = resolveDetail(detailMap, p.articleNumber);
      cells.push(esc(detail?.detailDescription ?? ''));
    }
    cells.push(esc(cleanBrokerageName(p.brokerageName)));
    if (detailMap) {
      const detail = resolveDetail(detailMap, p.articleNumber);
      cells.push(
        esc(detail?.realtorName ?? ''),
        esc(detail?.realtorAddress ?? ''),
        esc(detail?.cellPhoneNo ?? ''),
        esc(detail?.representativeTelNo ?? ''),
        detail ? `${detail.dealCount}` : '-',
        detail ? `${detail.leaseCount}` : '-',
        detail ? `${detail.rentCount}` : '-',
      );
    }
    return cells.join(' | ');
  });

  const md = [`# 매물 조회 결과`, ``, `총 ${properties.length.toLocaleString()}건`, ``,
    headerRow, sep, ...rows].join('\n');

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filenameBase ? `${filenameBase}.md` : `listings_${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function toPriceUnitStr(priceWon: number, unit: PriceUnit, divideByPyeong?: number): string {
  const base = divideByPyeong ? Math.round(priceWon / divideByPyeong) : priceWon;
  return formatPriceByUnit(base, unit);
}
