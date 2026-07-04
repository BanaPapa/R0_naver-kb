// 분석 결과·데이터 내보내기. 다른 AI에 그대로 전달할 수 있는 .md/.json/.xlsx 를 생성한다.
import * as XLSX from 'xlsx';
import type { AnalysisScope, AnalysisDataset } from '../../../entities/analysis';
import { parseReportTabs } from '../ui/AnalysisResult';
import { parseTabStructure } from './report-structure';

// ===TAB: 라벨=== 구분선을 `# 라벨` 제목으로 바꾸고, 챕터(탭)마다 실선(---)으로 구분한다.
// 종합 다음 지역, 지역과 지역 사이가 실선으로 나뉘어 외부 공유 시 가독성이 좋다.
function reportToHeadings(report: string): string {
  const tabs = parseReportTabs(report);
  if (tabs.length <= 1) return tabs[0]?.body ?? report.trim();
  return tabs.map(t => `# ${t.label}\n\n${t.body}`).join('\n\n---\n\n');
}

// 클립보드 복사용. 보고서만(원본 데이터 JSON 제외) — 챕터 실선 구분 포함.
export function toClipboardMarkdown(report: string): string {
  return reportToHeadings(report);
}

function scopeMeta(scope: AnalysisScope | null): string {
  if (!scope) return '- (스코프 정보 없음)';
  return [
    `- 모드: ${scope.mode}`,
    `- 기간: ${scope.period.from} ~ ${scope.period.to}`,
    `- 지역: ${scope.regions.map(r => scope.regionLabels[r] ?? r).join(', ')}`,
  ].join('\n');
}

// 보고서 + 데이터(JSON 코드블록). AI 핸드오프 기본 형식.
export function toExportMarkdown(report: string, scope: AnalysisScope | null, datasets: AnalysisDataset[]): string {
  const json = JSON.stringify({ scope, datasets }, null, 2);
  return [
    reportToHeadings(report),
    '',
    '---',
    '',
    '## 데이터',
    '',
    '분석에 사용된 원본 데이터입니다(다른 AI에 그대로 전달 가능).',
    '',
    scopeMeta(scope),
    '',
    '```json',
    json,
    '```',
    '',
  ].join('\n');
}

// 분석 결과를 탭·섹션으로 구조화. JSON 내보내기에서 데이터와 분석을 구분해 담기 위함.
function structuredTabs(report: string) {
  return parseReportTabs(report).map(t => {
    const { recognized, ...struct } = parseTabStructure(t.body);
    void recognized;
    return { label: t.label, ...struct };
  });
}

// JSON: 분석 결과(원문 + 구조화)와 원본 데이터를 명확히 구분해 담는다.
export function toExportJson(report: string, scope: AnalysisScope | null, datasets: AnalysisDataset[]): string {
  return JSON.stringify(
    {
      analysis: { raw: report, tabs: structuredTabs(report) },
      scope,
      datasets,
    },
    null,
    2,
  );
}

// 엑셀 시트명 제약(31자, 특수문자 불가) + 중복 방지.
function sheetName(used: Set<string>, raw: string): string {
  const cleaned = raw.replace(/[[\]:*?/\\]/g, ' ').slice(0, 28).trim() || 'sheet';
  let name = cleaned;
  let n = 2;
  while (used.has(name)) {
    const suffix = ` ${n}`;
    name = cleaned.slice(0, 28 - suffix.length) + suffix;
    n += 1;
  }
  used.add(name);
  return name;
}

// 한 데이터셋의 모든 날짜 합집합(정렬).
function unionDates(d: AnalysisDataset): string[] {
  const set = new Set<string>();
  for (const rs of Object.values(d.byRegion)) for (const p of rs.series) set.add(p.date);
  return Array.from(set).sort();
}

// Excel: '분석 결과' 시트(섹션별 행) + 지표별 데이터 시트(날짜 행 × 지역 열).
export function toXlsxBlob(report: string, scope: AnalysisScope | null, datasets: AnalysisDataset[]): Blob {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const label = (key: string) => scope?.regionLabels[key] ?? key;

  // 1) 분석 결과 시트
  const aoa: (string | number)[][] = [['탭', '구분', '내용']];
  for (const t of parseReportTabs(report)) {
    const s = parseTabStructure(t.body);
    if (s.recognized) {
      if (s.conclusion) aoa.push([t.label, '결론', s.conclusion]);
      s.insights.forEach((it, i) => aoa.push([i === 0 && !s.conclusion ? t.label : '', `인사이트 ${i + 1}`, it]));
      s.keyPoints.forEach((kp, i) => {
        aoa.push(['', `핵심 내용 ${i + 1}`, kp.point]);
        if (kp.basis) aoa.push(['', `근거 ${i + 1}`, kp.basis]);
      });
      if (s.forecast) aoa.push(['', '향후 전망', s.forecast]);
      s.questions.forEach((q, i) => {
        aoa.push(['', `의문점 ${i + 1}`, q.question]);
        if (q.prompt) aoa.push(['', `프롬프트 ${i + 1}`, q.prompt]);
      });
    } else {
      aoa.push([t.label, '분석', t.body]);
    }
    aoa.push([]); // 탭 사이 빈 줄
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(wb, ws, sheetName(used, '분석 결과'));

  // 2) 지표별 데이터 시트
  for (const d of datasets) {
    const regions = Object.keys(d.byRegion);
    const dates = unionDates(d);
    const header = ['날짜', ...regions.map(r => label(r))];
    const maps = regions.map(r => {
      const m = new Map<string, number | null>();
      for (const p of d.byRegion[r]!.series) m.set(p.date, p.value);
      return m;
    });
    const rows: (string | number)[][] = [header];
    for (const date of dates) {
      const row: (string | number)[] = [date];
      maps.forEach(m => {
        const v = m.get(date);
        row.push(v == null ? '' : v);
      });
      rows.push(row);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName(used, d.label || d.metric));
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// 파일명 베이스(확장자 제외).
export function exportBaseName(): string {
  return `analysis-${new Date().toISOString().slice(0, 10)}`;
}

// 텍스트 콘텐츠를 파일로 다운로드(브라우저 전용).
export function downloadTextFile(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: `${mime};charset=utf-8` }));
}

// Blob 다운로드(브라우저 전용).
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
