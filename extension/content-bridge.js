// Estate-OS 매물시세 연결기 — content script 브릿지
//
// 웹앱 페이지(window)와 확장 백그라운드(chrome.runtime) 사이를 postMessage로 잇는다.
// 페이지는 확장 ID를 몰라도 되고, chrome.* API에 접근하지 않는다.
//
// 프로토콜:
//   페이지 → 브릿지: postMessage({ source:'eos-page', id, kind, payload })
//   브릿지 → 페이지: postMessage({ source:'eos-ext',  id, result })

const PAGE_SOURCE = 'eos-page';
const EXT_SOURCE = 'eos-ext';

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE || typeof data.id !== 'string') return;

  chrome.runtime.sendMessage({ kind: data.kind, payload: data.payload }, (response) => {
    const err = chrome.runtime.lastError;
    window.postMessage(
      {
        source: EXT_SOURCE,
        id: data.id,
        result: err ? { error: err.message } : response,
      },
      window.location.origin,
    );
  });
});

// 페이지가 로드 직후 확장 존재를 즉시 감지할 수 있도록 신호를 남긴다.
window.postMessage({ source: EXT_SOURCE, id: 'ready', result: { ready: true } }, window.location.origin);
