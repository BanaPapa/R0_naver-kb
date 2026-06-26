# 컨트롤 패널 통합 가이드

이 문서는 앞으로 Estate OS에 합쳐질 모든 앱의 좌측 검색/조건 패널 통합 규칙입니다.
매물시세, KB 시계열 분석, 이후 추가될 앱은 같은 컴포넌트와 같은 역할 토큰을 사용해야
설정에서 글자 크기, 글꼴, 색상, 간격을 한 번에 조절할 수 있습니다.

## 핵심 원칙

좌측 컨트롤 패널 안에서는 `text-sm`, `font-bold`, `text-gray-400` 같은 임의의
타이포그래피 클래스를 직접 쓰지 않습니다. 반드시 아래 공통 컴포넌트를 사용합니다.

```ts
src/components/control-panel.tsx
```

이 컴포넌트들은 설정 > 표시 설정 > 네비게이션 패널 텍스트의 5개 역할 토큰에 연결됩니다.

## 공통 컴포넌트

| 컴포넌트 | 사용 대상 | 설정 역할 |
|---|---|---|
| `ControlSection` | `지역 선택`, `표시기간`, `상품종류` 같은 큰 섹션 제목 | 제목 |
| `ControlField` | `대지역 (시/도 · 집계)` 같은 보조 필드 라벨 | 설명글 |
| `ControlSelect` | select 입력과 현재 선택값 | 항목 |
| `ControlButton variant="secondary"` | `전체 해제`, `Y축 초기화`, `1년`, `3년` 같은 보조 버튼 | 버튼 1 |
| `ControlButton variant="primary"` | `추가`, `데이터 수집 실행` 같은 주요 실행 버튼 | 버튼 2 |

## 설정 역할 기본값

| 역할 | CSS 변수 | 기본값 |
|---|---|---|
| 제목 | `--ctrl-title-*` | 14px / 700 / `var(--fg)` |
| 항목 | `--ctrl-item-*` | 16px / 600 / `var(--fg)` |
| 설명글 | `--ctrl-desc-*` | 12px / 500 / `var(--muted)` |
| 버튼 1 | `--ctrl-button1-*` | 13px / 600 / `var(--fg-2)` |
| 버튼 2 | `--ctrl-button2-*` | 16.5px / 700 / `var(--blue-contrast)` |

큰 섹션 사이 간격은 다음 변수로 통제합니다.

```css
--ctrl-section-gap: calc(var(--ctrl-title-line) * 3);
```

## 권장 패턴

```tsx
import {
  ControlButton,
  ControlField,
  ControlSection,
  ControlSelect,
} from '../components/control-panel';

export function ExamplePanel() {
  return (
    <>
      <ControlSection title="표시기간">
        {/* 기간 선택 컨트롤 */}
      </ControlSection>

      <ControlSection
        title="지역 선택"
        headerRight={<ControlButton>전체 해제</ControlButton>}
      >
        <ControlField label="대지역 (시/도 · 집계)">
          <ControlSelect value={large} onChange={handleLargeChange}>
            <option value="">선택</option>
          </ControlSelect>
        </ControlField>

        <ControlButton variant="primary">
          추가
        </ControlButton>
      </ControlSection>
    </>
  );
}
```

## 레이아웃 규칙

- 좌측 패널 본문 padding은 패널 컨테이너에서만 제공합니다. 현재 기준은 `16px`입니다.
- 각 `ControlSection`은 별도의 좌우 padding을 갖지 않습니다.
- 큰 제목은 항상 `ControlSection`의 `title`로 넣습니다.
- 보조 라벨은 `ControlField`의 `label`로 넣습니다.
- 일반 select는 `ControlSelect`를 사용합니다.
- 패널 내부 버튼은 `ControlButton`을 사용합니다.
- 공통 컴포넌트로 표현하기 어려운 특수 컨트롤만 직접 구현합니다.
- 직접 구현이 필요하면 가장 가까운 역할 클래스를 반드시 붙입니다.
  - `ctrl-title`
  - `ctrl-item`
  - `ctrl-desc`
  - `ctrl-button-1`
  - `ctrl-button-2`

## 금지 패턴

```tsx
// 통합 앱의 좌측 패널에서는 피해야 합니다.
<h2 className="text-sm font-bold text-gray-800">지역 선택</h2>
<label className="text-xs text-gray-400">대지역</label>
<button className="text-xs border px-2">전체 해제</button>
```

이런 클래스는 표시 설정을 우회하기 때문에 앱마다 글자 크기, 색상, 위치가 다시 달라집니다.

## 통합 전 체크리스트

- 첫 번째 패널 제목이 기존 앱과 같은 x/y 위치에서 시작하는가?
- 모든 큰 제목이 `ControlSection`을 사용하는가?
- 큰 섹션 간격이 `--ctrl-section-gap`을 따르는가?
- 보조 라벨이 `ControlField`를 사용하는가?
- select 입력이 `ControlSelect`를 사용하는가?
- 주요/보조 버튼이 `ControlButton`을 사용하는가?
- 좌측 패널 안에 하드코딩된 `text-*`, `font-*`, `text-gray-*` 같은 타이포그래피 클래스가 남아 있지 않은가?
- 예외가 있다면 차트, 테이블, 지도 등 패널 외부 콘텐츠에 한정되어 있는가?
