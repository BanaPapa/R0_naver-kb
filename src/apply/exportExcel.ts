import * as XLSX from 'xlsx';
import { ApplyApartment, ApplySavedSlot, ApplySearchMeta } from './types';

type ColSpec = { header: string; key: keyof ApplyApartment | 'no'; width: number };

const COLS: ColSpec[] = [
  { header: '번호',         key: 'no',                     width: 7  },
  { header: '지역',         key: 'region',                  width: 10 },
  { header: '단지명',       key: 'houseName',               width: 32 },
  { header: '시공사',       key: 'constructor',             width: 22 },
  { header: '모집공고일',   key: 'noticeDate',              width: 14 },
  { header: '청약기간',     key: 'subscriptionPeriod',      width: 22 },
  { header: '당첨자발표일', key: 'announcementDate',        width: 14 },
  { header: '총세대수',     key: 'totalUnits',              width: 10 },
  { header: '1순위접수',    key: 'firstRoundApplications',  width: 11 },
  { header: '평균경쟁률',   key: 'averageCompetitionRate',  width: 11 },
  { header: '최고경쟁률',   key: 'maxCompetitionRate',      width: 11 },
  { header: '청약결과',     key: 'subscriptionResult',      width: 14 },
];

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

function rate(v: number): number | null {
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

function buildRows(apartments: ApplyApartment[]): unknown[][] {
  return apartments.map((a, i) => [
    i + 1,
    a.region || '-',
    a.houseName || '-',
    a.constructor || '-',
    a.noticeDate || '-',
    a.subscriptionPeriod || '-',
    a.announcementDate || '-',
    toNum(a.totalUnits),
    toNum(a.firstRoundApplications),
    rate(a.averageCompetitionRate),
    rate(a.maxCompetitionRate),
    a.subscriptionResult || '-',
  ]);
}

function makeWorksheet(apartments: ApplyApartment[]): XLSX.WorkSheet {
  const headers = COLS.map((c) => c.header);
  const data = [headers, ...buildRows(apartments)];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = COLS.map((c) => ({ wch: c.width }));
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(COLS.length - 1)}1` };
  return ws;
}

function downloadWorkbook(wb: XLSX.WorkBook, filename: string): void {
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeSheetName(name: string): string {
  const clean = name.replace(/[\\/?*[\]:]/g, ' ').trim() || '시트';
  return clean.slice(0, 31);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function ym(v: string): string {
  return v && v.length >= 6 ? `${v.slice(0, 4)}.${v.slice(4, 6)}` : v;
}

export function buildExportBaseName(meta: ApplySearchMeta, count: number): string {
  const now = new Date();
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  const region = (meta.regionName || '전체').trim();
  const period = meta.startDate && meta.endDate ? `${ym(meta.startDate)}~${ym(meta.endDate)}` : '';
  const kw = meta.keyword ? ` ${meta.keyword}` : '';
  return sanitizeFileName(`${date} ${region} ${period}${kw} 청약 ${count.toLocaleString()}건`);
}

export function exportApartmentsExcel(rows: ApplyApartment[], filenameBase?: string): void {
  if (rows.length === 0) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeWorksheet(rows), '청약');
  const name = filenameBase ? `${filenameBase}.xlsx` : `apply_${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadWorkbook(wb, name);
}

export function exportSlotsExcel(slots: ApplySavedSlot[]): void {
  const valid = slots.filter((s) => s.apartments.length > 0);
  if (valid.length === 0) return;
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  valid.forEach((slot, idx) => {
    let base = sanitizeSheetName(`${idx + 1}_${slot.meta.regionName || '전체'}`);
    let name = base;
    let dup = 2;
    while (used.has(name)) name = sanitizeSheetName(`${base} (${dup++})`);
    used.add(name);
    XLSX.utils.book_append_sheet(wb, makeWorksheet(slot.apartments), name);
  });
  downloadWorkbook(wb, `apply_slots_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function exportApartmentsMarkdown(rows: ApplyApartment[], meta?: ApplySearchMeta): string {
  const header = [
    `# 청약 경쟁률 조회 결과`,
    `지역: ${meta?.regionName || '전체'} | 기간: ${meta ? `${ym(meta.startDate)}~${ym(meta.endDate)}` : '-'} | 건수: ${rows.length.toLocaleString()}건`,
    '',
    '| 번호 | 지역 | 단지명 | 시공사 | 모집공고일 | 청약기간 | 총세대수 | 1순위접수 | 평균경쟁률 | 최고경쟁률 | 청약결과 |',
    '|------|------|--------|--------|-----------|---------|---------|---------|-----------|-----------|---------|',
  ].join('\n');

  const dataRows = rows
    .map((a, i) => {
      const avg = a.averageCompetitionRate != null ? `${a.averageCompetitionRate.toFixed(2)} : 1` : '-';
      const max = a.maxCompetitionRate != null ? `${a.maxCompetitionRate.toFixed(2)} : 1` : '-';
      return `| ${i + 1} | ${a.region || '-'} | ${a.houseName || '-'} | ${a.constructor || '-'} | ${a.noticeDate || '-'} | ${a.subscriptionPeriod || '-'} | ${a.totalUnits || '-'} | ${a.firstRoundApplications || '-'} | ${avg} | ${max} | ${a.subscriptionResult || '-'} |`;
    })
    .join('\n');

  return `${header}\n${dataRows}\n`;
}

export function downloadMarkdown(content: string, filenameBase?: string): void {
  const blob = new Blob([content], { type: 'text/markdown; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase ? sanitizeFileName(filenameBase) : `apply_${new Date().toISOString().slice(0, 10)}`}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportApartmentsJSON(rows: ApplyApartment[], filenameBase?: string): void {
  if (rows.length === 0) return;
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase ? sanitizeFileName(filenameBase) : `apply_${new Date().toISOString().slice(0, 10)}`}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
