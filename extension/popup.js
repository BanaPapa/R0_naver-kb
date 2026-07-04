// 팝업: 네이버·호갱노노 로그인 상태를 표시한다.
chrome.runtime.sendMessage({ kind: 'STATUS' }, (res) => {
  const dot = document.getElementById('dot-login');
  const txt = document.getElementById('txt-login');
  if (chrome.runtime.lastError || !res) {
    dot.className = 'dot off';
    txt.textContent = '연결 오류 — 확장을 다시 로드하세요.';
    return;
  }
  if (res.loggedIn) {
    dot.className = 'dot on';
    txt.textContent = '매물 사이트 로그인됨 — 검색 준비 완료';
  } else {
    dot.className = 'dot on';
    txt.textContent = '로그인 없이 사용 가능 (막히면 로그인 권장)';
  }
});

chrome.runtime.sendMessage({ kind: 'HGNN_STATUS' }, (res) => {
  const dot = document.getElementById('dot-hgnn');
  const txt = document.getElementById('txt-hgnn');
  if (chrome.runtime.lastError || !res) {
    dot.className = 'dot off';
    txt.textContent = '리뷰 사이트 상태 확인 실패';
    return;
  }
  if (res.loggedIn) {
    dot.className = 'dot on';
    txt.textContent = '리뷰 사이트 로그인됨 — 리뷰 조회 가능';
  } else {
    dot.className = 'dot off';
    txt.textContent = '리뷰 사이트 로그인 필요 (리뷰 조회용)';
  }
});
