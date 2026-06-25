import { useMonthlyStore } from '../../../shared/lib/monthly-store';
import { useRegionSync } from '../model/sync-store';
import { syncFromActiveMode } from '../lib/region-sync';

interface RegionSyncToggleProps {
  inline?: boolean;
}

// 사이드바 상단의 주간·월간 연동 체크박스.
// 켜면 현재 보는 화면 기준으로 반대쪽 지역·기준월·기간을 맞추고, 이후 한쪽 변경이 양쪽에 반영된다.
export function RegionSyncToggle({ inline = false }: RegionSyncToggleProps) {
  const linked = useRegionSync(s => s.linked);
  const notice = useRegionSync(s => s.notice);
  const setLinked = useRegionSync(s => s.setLinked);
  const setNotice = useRegionSync(s => s.setNotice);
  const mode = useMonthlyStore(s => s.mode);
  const help = '주간·월간 연동: 지역·기준월·기간을 한쪽에서 바꾸면 양쪽이 함께 바뀝니다.';

  const toggle = () => {
    const next = !linked;
    setLinked(next);
    if (next) {
      syncFromActiveMode(mode);
      // 안내 문구는 잠시 후 자동 해제.
      window.setTimeout(() => setNotice(null), 7000);
    } else {
      setNotice(null);
    }
  };

  if (inline) {
    return (
      <label className={`kb-sync-inline${linked ? ' active' : ''}`} title={help}>
        <input
          type="checkbox"
          checked={linked}
          onChange={toggle}
          aria-label="주간·월간 연동"
        />
      </label>
    );
  }

  return (
    <div className="pt-3">
      <label
        title={help}
        className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
          linked ? 'border-blue-300 bg-blue-50' : 'border-gray-300 bg-gray-100 hover:bg-gray-200'
        }`}
      >
        <input
          type="checkbox"
          checked={linked}
          onChange={toggle}
          className="mt-0.5 flex-none"
        />
        <span className="min-w-0">
          <span className={`block text-sm font-semibold ${linked ? 'text-blue-700' : 'text-gray-700'}`}>
            주간·월간 연동
          </span>
          <span className="block text-xs leading-snug text-gray-500">
            지역·기준월·기간을 한쪽에서 바꾸면 양쪽이 함께 바뀝니다.
          </span>
        </span>
      </label>
      {linked && notice && (
        <p className="eos-tip-amber mt-1.5 rounded-md px-2.5 py-1.5 text-xs leading-snug">
          {notice}
        </p>
      )}
    </div>
  );
}
