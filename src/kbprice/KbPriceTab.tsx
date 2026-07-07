import React, { useState } from 'react';
import { KbPriceSearchPanel } from './KbPriceSearchPanel';
import { KbPriceResults } from './KbPriceResults';
import { KbPriceSlotModal } from './KbPriceSlotModal';
import { InfoModal } from '../components/InfoModal';
import { useKbSlots, KbSavedSlot } from './slots';
import { useKbPriceStore } from './store';
import { executeKbSearch } from './runSearch';
import './kbprice.css';

interface KbPriceTabProps {
  userId: string | null; // 로그인 시 슬롯을 Supabase(kbprice_slots)에 영속
}

// KB시세 조회 탭 (R2_KB 앱 이식) — 좌측 검색 패널 + 우측 결과 뷰 + 저장 슬롯
export function KbPriceTab({ userId }: KbPriceTabProps) {
  const [ctrlCollapsed, setCtrlCollapsed] = useState(false);
  const [slotModalOpen, setSlotModalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const slots = useKbSlots(userId);
  const {
    results,
    searchParams,
    regionSelection,
    areaUnit,
    priceUnit,
    setSearchParams,
    setRegionSelection,
    setResults,
  } = useKbPriceStore();

  const canSave = results.length > 0 && !!regionSelection.mid;
  const savedCount = slots.slots.filter(Boolean).length;

  // 첫 빈 슬롯에 저장 후 슬롯 목록 열기 (매물시세와 동일 UX)
  const handleSaveSlot = () => {
    if (!canSave) return;
    const idx = slots.saveFirstEmpty(searchParams, regionSelection, results);
    if (idx === -1) {
      alert('저장 슬롯이 가득 찼습니다 (최대 20개). 기존 슬롯을 삭제한 뒤 다시 시도해 주세요.');
      return;
    }
    setSlotModalOpen(true);
  };

  // 지정 슬롯에 저장/덮어쓰기
  const handleSaveAt = (index: number) => {
    if (!canSave) return;
    slots.saveAt(index, searchParams, regionSelection, results);
  };

  // 슬롯 데이터를 현재 결과로 불러오기 (검색 조건·지역도 함께 복원)
  const handleLoad = (slot: KbSavedSlot) => {
    setRegionSelection(slot.region);
    setSearchParams(slot.params);
    setResults(slot.results);
    setSlotModalOpen(false);
    setNotice('데이터를 성공적으로 불러왔습니다.');
  };

  // 같은 조건으로 재검색
  const handleReSearch = (slot: KbSavedSlot) => {
    setSlotModalOpen(false);
    setRegionSelection(slot.region);
    setSearchParams(slot.params);
    void executeKbSearch();
  };

  return (
    <div className={`eos-work${ctrlCollapsed ? ' ctrl-collapsed' : ''}`}>
      <KbPriceSearchPanel onToggleCollapse={() => setCtrlCollapsed((v) => !v)} />
      <KbPriceResults
        canSave={canSave}
        savedCount={savedCount}
        onSaveSlot={handleSaveSlot}
        onOpenSlots={() => setSlotModalOpen(true)}
      />

      {slotModalOpen && (
        <KbPriceSlotModal
          slots={slots.slots}
          areaUnit={areaUnit}
          priceUnit={priceUnit}
          canSave={canSave}
          onSaveAt={handleSaveAt}
          onLoad={handleLoad}
          onReSearch={handleReSearch}
          onDelete={slots.deleteSlot}
          onClose={() => setSlotModalOpen(false)}
        />
      )}

      {notice && <InfoModal message={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
