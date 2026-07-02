// 팝업: 네이버 로그인 상태를 표시한다.
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
    txt.textContent = '네이버 로그인됨 — 검색 준비 완료';
  } else {
    dot.className = 'dot on';
    txt.textContent = '로그인 없이 사용 가능 (막히면 로그인 권장)';
  }
});
