import { useMonthlyStore, type ViewMode, type WeeklyTab } from '../../shared/lib/monthly-store';
import { RegionSyncToggle } from '../../features/region-sync';

const MODE_TABS: { key: ViewMode; label: string }[] = [
  { key: 'weekly', label: '주간' },
  { key: 'monthly', label: '월간' },
];

const WEEKLY_TABS: { key: WeeklyTab; label: string }[] = [
  { key: 'price', label: '시세지표' },
  { key: 'trade', label: '거래지표' },
];

const MONTHLY_TABS: { key: WeeklyTab; label: string }[] = [
  ...WEEKLY_TABS,
  { key: 'market', label: '시장지표' },
];

interface ViewModeControlsProps {
  compact?: boolean;
}

export function ViewModeControls({ compact = false }: ViewModeControlsProps) {
  const { mode, setMode, weeklyTab, setWeeklyTab } = useMonthlyStore();
  const tabs = mode === 'monthly' ? MONTHLY_TABS : WEEKLY_TABS;
  const selectMode = (next: ViewMode) => {
    setMode(next);
    if (next === 'weekly' && weeklyTab === 'market') setWeeklyTab('price');
  };

  return (
    <div className={`kb-view-controls${compact ? ' compact' : ''}`}>
      {compact && <RegionSyncToggle inline />}
      <div className="eos-seg">
        {MODE_TABS.map(t => (
          <button
            key={t.key}
            className={`eos-seg-btn${mode === t.key ? ' active' : ''}`}
            onClick={() => selectMode(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="eos-seg">
        {tabs.map(t => (
          <button
            key={t.key}
            className={`eos-seg-btn${weeklyTab === t.key ? ' active' : ''}`}
            onClick={() => setWeeklyTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
