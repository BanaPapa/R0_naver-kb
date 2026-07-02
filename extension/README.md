# Estate-OS 매물시세 연결기 (브라우저 확장)

네이버가 데이터센터 IP를 차단하므로, 이 확장이 **사용자 브라우저(주거 IP)** 에서
네이버 부동산 API를 대신 호출해 Estate-OS 웹앱에 결과를 돌려준다.
Electron 트레이앱(다운로드 설치본)을 대체한다.

## 구조

- `manifest.json` — MV3. host_permissions로 `*.naver.com`, content_script를 웹앱 도메인에 주입.
- `background.js` — service worker. 웹앱 요청을 받아 네이버를 fetch(브라우저 쿠키 자동 포함).
  `webRequest`로 new.land Authorization(Bearer)을 수동 캡처.
- `content-bridge.js` — 웹앱 페이지 ↔ 백그라운드 사이 postMessage 브릿지.
- `popup.html` / `popup.js` — 네이버 로그인 상태 표시.
- `icons/` — 확장 아이콘.

웹앱 쪽 대응 코드: `src/services/extensionBridge.ts`, `src/services/agentApi.ts`,
`src/services/naverApi.ts`.

## 개발 중 로드 (unpacked)

1. 크롬/엣지 주소창에 `chrome://extensions` (엣지는 `edge://extensions`).
2. 우측 상단 **개발자 모드** 켜기.
3. **압축해제된 확장 프로그램을 로드** → 이 `extension/` 폴더 선택.
4. 네이버(naver.com)에 평소처럼 로그인.
5. Estate-OS 웹앱(로컬 `http://localhost:5174` 또는 배포본)에서 매물시세 탭 진입 → 자동 연결.

> 로컬 개발본에서 테스트하려면 manifest의 content_scripts matches에 이미
> `http://localhost:5174/*` 가 포함되어 있다.

## 웹스토어 배포

1. [Chrome 웹스토어 개발자 대시보드](https://chrome.google.com/webstore/devconsole)에서
   개발자 등록($5 1회).
2. `extension/` 폴더를 zip으로 압축해 업로드. (icons·manifest 포함, node_modules 없음)
3. 스토어 등록·심사(최초 수 일). 게시 후 확장 ID가 확정된다.
4. 확정된 ID로 `src/services/agentApi.ts`의 `EXTENSION_STORE_URL`을 실제 상세 페이지
   URL(`https://chromewebstore.google.com/detail/<slug>/<id>`)로 교체.
5. 엣지 애드온 스토어도 동일 zip으로 별도 등록 가능(선택).

## 버전 올릴 때

`manifest.json`의 `version`을 올리고 스토어에 재업로드하면 사용자에게 자동 업데이트된다.
(Electron처럼 사용자가 재설치할 필요 없음)

## 도메인 변경 시

웹앱 배포 도메인이 `estate-os.vercel.app`가 아니게 되면
`manifest.json`의 `content_scripts.matches`에 새 도메인을 추가해야 확장이 주입된다.
