// 리뷰 내보내기 (Excel/JSON/Markdown). R7 exportUtils 포트.
import * as XLSX from 'xlsx';
import type { ReviewsByApt } from '../types';

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function triggerDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportToExcel(reviewsByApt: ReviewsByApt): void {
  const wb = XLSX.utils.book_new();
  const count = Object.keys(reviewsByApt).length;
  for (const { aptName, reviews } of Object.values(reviewsByApt)) {
    const rows = reviews.map((r, i) => ({
      번호: i + 1,
      날짜: r.date ?? '',
      내용: r.content ?? '',
      평점: r.score ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    // Excel 시트명: 최대 31자, 특수문자 불가
    const sheetName = aptName.replace(/[:\\/?*[\]]/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetName || `단지${count}`);
  }
  XLSX.writeFile(wb, `리뷰_${today()}.xlsx`);
}

export function exportToJSON(reviewsByApt: ReviewsByApt): void {
  const data = Object.values(reviewsByApt).map(({ aptName, reviews }) => ({
    aptName,
    count: reviews.length,
    reviews,
  }));
  triggerDownload(JSON.stringify(data, null, 2), `리뷰_${today()}.json`, 'application/json');
}

export function exportToMarkdown(reviewsByApt: ReviewsByApt): void {
  const parts: string[] = [`# 호갱노노 리뷰 수집 결과\n\n수집일: ${today()}\n`];
  for (const { aptName, reviews } of Object.values(reviewsByApt)) {
    parts.push(`\n## ${aptName} (${reviews.length}개)`);
    reviews.forEach((r, i) => {
      parts.push(`\n### ${i + 1}. ${r.date ?? '날짜 없음'}`);
      parts.push(r.content ?? '');
    });
  }
  triggerDownload(parts.join('\n'), `리뷰_${today()}.md`, 'text/markdown;charset=utf-8');
}
