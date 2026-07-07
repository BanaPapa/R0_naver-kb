import ExcelJS from 'exceljs';
import { ProcessedData, PriceType } from './types';
import type { KbSavedSlot } from './slots';
import {
  type AreaUnit,
  type PriceUnit,
  AREA_UNIT_LABEL,
  PRICE_UNIT_LABEL,
  sqmToPyeong,
  convertPrice,
} from './units';
import { format입주연차, format평당가 } from './tableFormat';

export interface ExportOptions {
  areaUnit: AreaUnit;
  priceUnit: PriceUnit;
  regionName: string;
  priceTypes: PriceType[];
  excludeTopFloor: boolean;
  propertyType: 1 | 2; // 1:아파트(공급면적), 2:오피스텔(계약면적)
}

// 시세 유형 순서 정의 (상위 → 일반 → 하위)
const PRICE_DEFS = [
  { type: '상위', key: '상위평균', label: '상위' },
  { type: '일반', key: '일반평균', label: '일반' },
  { type: '하위', key: '하위평균', label: '하위' },
] as const;

type Align = 'left' | 'center';
interface ExportColumn {
  header: string;
  align: Align; // 본문(td) 정렬
  headerAlign?: Align; // 헤더(th) 정렬 — 생략 시 align 을 따름
  width: number; // 엑셀 열 너비 (문자 수 단위)
  value: (item: ProcessedData) => string;
}

// 면적값(㎡ 기준)을 선택 단위 숫자 문자열로 변환 (단위 기호 없음 — 헤더가 단위 표기)
function areaValue(sqm: number, unit: AreaUnit): string {
  if (sqm <= 0) return '-';
  const value = unit === 'pyeong' ? sqmToPyeong(sqm) : sqm;
  return value.toFixed(2);
}

// 가격값(만원 기준)을 선택 단위 숫자 문자열로 변환
function priceValue(manwon: number, unit: PriceUnit): string {
  return manwon > 0 ? convertPrice(manwon, unit).toLocaleString() : '-';
}

// 결과 테이블과 동일한 컬럼 구성 (동 → 단지명 → 세대수 → 입주연차 → 전용 → 공급 → 타입 → [탑층] → 평균들 → 평당가들)
function buildColumns(options: ExportOptions): ExportColumn[] {
  const { areaUnit, priceUnit, regionName, priceTypes, excludeTopFloor, propertyType } = options;
  const isOfficetel = propertyType === 2;
  const a = AREA_UNIT_LABEL[areaUnit];
  const p = PRICE_UNIT_LABEL[priceUnit];
  const selected = PRICE_DEFS.filter((d) => priceTypes.includes(d.type));

  const columns: ExportColumn[] = [
    { header: '동', align: 'center', width: 15, value: (i) => i.동 || regionName },
    // 단지명은 본문은 좌측 정렬, 헤더만 가운데 정렬
    { header: '단지명', align: 'left', headerAlign: 'center', width: 30, value: (i) => i.단지명 },
    { header: '세대수', align: 'center', width: 15, value: (i) => i.세대수?.toLocaleString() ?? '-' },
    { header: '입주연차', align: 'center', width: 20, value: (i) => format입주연차(i.입주년월) },
    { header: `전용(${a})`, align: 'center', width: 15, value: (i) => areaValue(i.전용면적, areaUnit) },
    // 아파트는 공급면적, 오피스텔은 계약면적
    isOfficetel
      ? { header: `계약(${a})`, align: 'center', width: 15, value: (i) => areaValue(i.계약면적, areaUnit) }
      : { header: `공급(${a})`, align: 'center', width: 15, value: (i) => areaValue(i.공급면적, areaUnit) },
    { header: '타입', align: 'center', width: 15, value: (i) => i.타입 || '' },
  ];

  if (!excludeTopFloor) {
    columns.push({
      header: '탑층',
      align: 'center',
      width: 15,
      value: (i) => (i.탑층여부 === '탑층' ? '탑층' : ''),
    });
  }

  selected.forEach((d) => {
    columns.push({
      header: `${d.label}평균(${p})`,
      align: 'center',
      width: 20,
      value: (i) => priceValue(i[d.key], priceUnit),
    });
  });

  selected.forEach((d) => {
    columns.push({
      header: `${d.label} 평당가(${p})`,
      align: 'center',
      width: 20,
      value: (i) => format평당가(i, i[d.key], priceUnit),
    });
  });

  return columns;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export class ExportService {
  static exportToCSV(
    data: ProcessedData[],
    filename: string = 'kb부동산_시세조회',
    options: ExportOptions,
  ): void {
    if (data.length === 0) throw new Error('내보낼 데이터가 없습니다.');

    const columns = buildColumns(options);
    const headerLine = columns.map((c) => csvCell(c.header)).join(',');
    const rows = data.map((item) => columns.map((c) => csvCell(c.value(item))).join(','));

    const BOM = '﻿';
    const csvContent = [headerLine, ...rows].join('\n');
    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    this.downloadFile(blob, `${filename}_${this.getDateString()}.csv`);
  }

  static exportToExcel(
    data: ProcessedData[],
    filename: string = 'kb부동산_시세조회',
    options: ExportOptions,
  ): void {
    if (data.length === 0) throw new Error('내보낼 데이터가 없습니다.');
    const html = this.generateExcelHTML(data, options);
    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    this.downloadFile(blob, `${filename}_${this.getDateString()}.xls`);
  }

  private static generateExcelHTML(data: ProcessedData[], options: ExportOptions): string {
    const columns = buildColumns(options);

    // 엑셀 열 너비: 문자 수 → 픽셀 근사 변환 (기본 글꼴 기준 px = 문자수 × 7 + 5)
    const colGroup = `<colgroup>${columns
      .map((c) => {
        const px = Math.round(c.width * 7 + 5);
        return `<col width="${px}" style="width:${px}px">`;
      })
      .join('')}</colgroup>`;

    const headerCells = columns
      .map((c) => `<th style="text-align:${c.headerAlign ?? c.align}">${c.header}</th>`)
      .join('');

    const rows = data
      .map(
        (item) => `
        <tr>${columns
          .map((c) => `<td style="text-align:${c.align}">${c.value(item)}</td>`)
          .join('')}</tr>`,
      )
      .join('');

    return `
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            table { border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; }
            th { background-color: #f2f2f2; font-weight: bold; }
          </style>
        </head>
        <body>
          <h2>KB부동산 시세조회 결과</h2>
          <p>생성일시: ${new Date().toLocaleString('ko-KR')}</p>
          <table>
            ${colGroup}
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>`;
  }

  private static downloadFile(blob: Blob, filename: string): void {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }

  private static getDateString(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
}

// ── 슬롯 일괄 내보내기 (매물시세 exportSlotsExcel 과 동일 UX: 슬롯별 시트 1개) ──

// Excel에서 금지된 시트명 문자 제거 + 31자 제한
function sanitizeSheetName(name: string): string {
  const clean = name.replace(/[\\/?*[\]:]/g, ' ').trim() || '시트';
  return clean.slice(0, 31);
}

export async function exportKbSlotsExcel(
  slots: KbSavedSlot[],
  areaUnit: AreaUnit,
  priceUnit: PriceUnit,
): Promise<void> {
  const valid = slots.filter((s) => s.results.length > 0);
  if (valid.length === 0) return;

  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set<string>();

  valid.forEach((slot, idx) => {
    const base = sanitizeSheetName(`${idx + 1}_${slot.meta.regionText}`);
    let name = base;
    let dup = 2;
    while (usedNames.has(name)) {
      name = sanitizeSheetName(`${base} (${dup++})`);
    }
    usedNames.add(name);

    // 탑층 포함 전체를 내보낸다 (화면 필터와 무관하게 슬롯 원본 보존)
    const columns = buildColumns({
      areaUnit,
      priceUnit,
      regionName: slot.meta.regionText,
      priceTypes: slot.meta.priceTypes,
      excludeTopFloor: false,
      propertyType: slot.meta.propertyType,
    });

    const worksheet = workbook.addWorksheet(name);
    worksheet.columns = columns.map((c, i) => ({
      header: c.header,
      key: `c${i}`,
      width: c.width,
      style: { alignment: { horizontal: c.align } },
    }));
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center' };

    for (const item of slot.results) {
      worksheet.addRow(columns.map((c) => c.value(item)));
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kb_slots_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
