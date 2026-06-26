import { useState } from 'react';
import { ModalPortal } from '../../../shared/ui/ModalPortal';
import { useSlotStore } from '../model/slot-store';
import { summarizeRegions } from '../lib/name';
import { SLOT_COUNT, SLOTS_PER_PAGE, type SlotEntry, type SlotMode } from '../model/types';
import { SaveChoiceDialog, type SaveChoice } from './SaveChoiceDialog';

interface SlotModalProps {
  mode: SlotMode;
  onClose: () => void;
}

const MODE_LABEL: Record<SlotMode, string> = { weekly: '주간', monthly: '월간' };

// 저장 시각: "2026-06-15 14:30"
function formatSavedAt(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 슬롯이 담은 모드 배지 텍스트.
function contentBadge(entry: SlotEntry): string {
  if (entry.weekly && entry.monthly) return '주간 · 월간';
  if (entry.weekly) return '주간';
  return '월간';
}

// 호버 툴팁: 슬롯에 저장된 지역 전체(주간/월간 각각).
function regionsTooltip(entry: SlotEntry): string {
  const fmt = (snap: { selectedRegions: string[]; regionLabels: Record<string, string> }) =>
    snap.selectedRegions.map(k => snap.regionLabels[k] ?? k).join(', ') || '(선택 없음)';
  const lines: string[] = [];
  if (entry.weekly) lines.push(`주간: ${fmt(entry.weekly)}`);
  if (entry.monthly) lines.push(`월간: ${fmt(entry.monthly)}`);
  return lines.join('\n');
}

// 목록에 보여줄 대표 정보(현재 모드 우선, 없으면 반대 모드).
function primaryInfo(entry: SlotEntry, mode: SlotMode) {
  const snap = entry[mode] ?? entry[mode === 'weekly' ? 'monthly' : 'weekly'];
  if (!snap) return { region: '(빈 슬롯)', period: '' };
  const region = summarizeRegions(snap.selectedRegions, snap.regionLabels);
  const from = snap.fromDate?.slice(0, 7) ?? '';
  const to = snap.toDate?.slice(0, 7) ?? '';
  return { region, period: from && to ? `${from} ~ ${to}` : '' };
}

export function SlotModal({ mode, onClose }: SlotModalProps) {
  const slots = useSlotStore(s => s.slots);
  const { saveToSlot, loadSlot, deleteSlot, renameSlot } = useSlotStore();

  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [saveIndex, setSaveIndex] = useState<number | null>(null);
  // 호버한 슬롯의 지역 툴팁(커서 추종 — 스크롤 영역에 잘리지 않도록 fixed).
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  const pages = Math.ceil(SLOT_COUNT / SLOTS_PER_PAGE);
  const start = page * SLOTS_PER_PAGE;
  const visible = Array.from({ length: SLOTS_PER_PAGE }, (_, k) => start + k);

  // 저장(여기에 저장/덮어쓰기) → 항상 선택 다이얼로그를 띄운다.
  const handleSave = (index: number) => setSaveIndex(index);

  // 다이얼로그 선택 처리: 주간만 / 월간만 / 둘 다.
  const handleChoose = (choice: SaveChoice) => {
    if (saveIndex === null) return;
    if (choice === 'both') saveToSlot('weekly', saveIndex, true);
    else saveToSlot(choice, saveIndex, false);
    setSaveIndex(null);
  };

  return (
    <ModalPortal>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        style={{ width: 'min(90vw, 1240px)', height: 'min(82vh, 760px)' }}
        className="relative flex min-w-[420px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h2 className="text-base font-bold text-gray-900">
            슬롯 저장 / 불러오기
            <span className="ml-2 text-xs font-normal text-gray-400">
              현재 화면: {MODE_LABEL[mode]}
            </span>
          </h2>
          <button onClick={onClose} className="eos-modal-x" aria-label="닫기">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* 슬롯 목록 — 각 행이 균등하게 늘어나 모달 높이를 채운다 */}
        <ul className="flex flex-1 flex-col gap-2 overflow-auto px-4 py-3">
          {visible.map(i => {
            const entry = slots[i] ?? null;
            const info = entry ? primaryInfo(entry, mode) : null;
            return (
              <li
                key={i}
                onMouseEnter={e => entry && setHover({ index: i, x: e.clientX, y: e.clientY })}
                onMouseMove={e => entry && setHover({ index: i, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(h => (h?.index === i ? null : h))}
                className="flex min-h-[3.55rem] items-center gap-3 rounded-lg border border-gray-100 px-4 hover:bg-gray-50"
              >
                <span className="w-7 shrink-0 text-center text-base font-bold text-gray-400">
                  {i + 1}
                </span>

                {entry && info ? (
                  <>
                    <div className="min-w-0 flex-1">
                      {/* 1줄: 담긴 모드 배지 + 지역 */}
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                          {contentBadge(entry)}
                        </span>
                        {editing === i ? (
                          <input
                            autoFocus
                            defaultValue={info.region}
                            onBlur={e => {
                              const v = e.target.value.trim();
                              if (v) renameSlot(i, v);
                              setEditing(null);
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              if (e.key === 'Escape') setEditing(null);
                            }}
                            className="min-w-0 flex-1 rounded border border-blue-300 px-1 text-base"
                          />
                        ) : (
                          <button
                            onDoubleClick={() => setEditing(i)}
                            title="더블클릭하여 이름 수정"
                            className="min-w-0 flex-1 truncate text-left text-base font-semibold text-gray-800"
                          >
                            {info.region}
                          </button>
                        )}
                      </div>
                      {/* 2줄: 기간 + 저장 시각 */}
                      <p className="mt-1 truncate text-sm text-gray-400">
                        {info.period && <span>{info.period}</span>}
                        {info.period && entry.updatedAt ? ' · ' : ''}
                        {entry.updatedAt && <span>저장 {formatSavedAt(entry.updatedAt)}</span>}
                      </p>
                    </div>

                    <button
                      onClick={() => {
                        loadSlot(i, mode);
                        onClose();
                      }}
                      className="shrink-0 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-blue-700"
                    >
                      불러오기
                    </button>
                    <button
                      onClick={() => handleSave(i)}
                      title="현재 화면으로 덮어쓰기"
                      className="shrink-0 rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
                    >
                      덮어쓰기
                    </button>
                    <button
                      onClick={() => deleteSlot(i)}
                      title="슬롯 삭제"
                      className="shrink-0 rounded-lg px-2 py-1.5 text-base text-gray-400 hover:text-red-500"
                    >
                      ✕
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 text-base text-gray-300">(빈 슬롯)</span>
                    <button
                      onClick={() => handleSave(i)}
                      className="shrink-0 rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-100"
                    >
                      여기에 저장
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>

        {/* 페이지네이션 — 이전/다음 + 페이지 번호 버튼 */}
        <div className="flex items-center justify-center gap-3 border-t border-gray-100 px-5 py-3">
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹ 이전
          </button>
          <div className="flex items-center gap-1.5">
            {Array.from({ length: pages }, (_, p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`h-9 w-9 rounded-lg text-sm font-bold transition-colors ${
                  page === p
                    ? 'bg-blue-600 text-white shadow'
                    : 'border border-gray-200 text-gray-600 hover:bg-gray-100'
                }`}
              >
                {p + 1}
              </button>
            ))}
          </div>
          <button
            onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3.5 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            다음 ›
          </button>
          <span className="ml-1 text-sm text-gray-400">
            {start + 1}–{start + SLOTS_PER_PAGE} / {SLOT_COUNT}
          </span>
        </div>

        {/* 저장 선택 다이얼로그 */}
        {saveIndex !== null && (
          <SaveChoiceDialog
            slotIndex={saveIndex}
            originMode={mode}
            onChoose={handleChoose}
            onCancel={() => setSaveIndex(null)}
          />
        )}
      </div>

      {/* 호버 슬롯의 저장 지역 툴팁 (커서 추종) */}
      {hover && slots[hover.index] && saveIndex === null && (
        <div
          style={{ position: 'fixed', left: hover.x + 14, top: hover.y + 14 }}
          className="pointer-events-none z-[70] max-w-md whitespace-pre-line rounded-lg bg-gray-900/95 px-3 py-2 text-sm leading-relaxed text-white shadow-xl"
        >
          {regionsTooltip(slots[hover.index]!)}
        </div>
      )}
    </div>
    </ModalPortal>
  );
}
