import React from 'react';
import { EXTENSION_STORE_URL } from '../services/agentApi';

// 매물시세·입주민 리뷰가 공용으로 쓰는 브라우저 확장 설치 안내 게이트.
// 두 탭 모두 같은 확장(Estate-OS 커넥터)을 쓰므로 문구·디자인을 이 한 곳에서 관리한다.
// (예전엔 매물시세에만 인라인으로 있었고 리뷰 탭은 토스트만 떠서 불일치했다.)
export function AgentInstallGate() {
  const openStore = () => window.open(EXTENSION_STORE_URL, '_blank', 'noreferrer');
  // 확장 설치 후 postMessage 재감지는 기존 탭에서 불안정하다(content script 미주입).
  // 전체 새로고침(F5와 동일)이 가장 확실하게 재연결시키므로 재시도는 리로드로 처리한다.
  const retry = () => window.location.reload();

  return (
    <div className="eos-state-screen">
      <div className="nv-agent-offline">
        <div className="nv-agent-offline-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="9" />
            <path d="M8 12h8M12 8v8" strokeLinecap="round" />
          </svg>
        </div>
        <h2>Estate-OS 커넥터(브라우저 확장)가 필요합니다</h2>
        <p>
          매물 검색과 입주민 리뷰 수집은 <b>브라우저 확장</b>을 통해
          <br />
          이 PC(내 인터넷)에서 직접 조회하는 방식으로 동작합니다.
          <br />
          크롬·엣지에서 <b>한 번만 설치</b>하면 됩니다. 별도 프로그램 다운로드는 없습니다.
        </p>

        <div className="nv-agent-paths">
          {/* 처음 설치 */}
          <div className="nv-agent-path-section nv-agent-path-install">
            <div className="nv-agent-path-info">
              <div className="nv-agent-path-label">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={16} height={16}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                처음이라면
              </div>
              <p className="nv-agent-path-desc">
                아래 <b>"웹스토어에서 설치"</b> 버튼을 누르면 설치 페이지로 바로 이동합니다.
                <br /><b>"Chrome에 추가"</b> 한 번이면 완료 — exe 다운로드·보안 경고 없이 바로 사용할 수 있습니다.
              </p>
            </div>
            <div className="nv-agent-path-action">
              <button className="btn-primary" onClick={openStore}>웹스토어에서 설치</button>
            </div>
          </div>

          {/* 이미 설치한 경우 */}
          <div className="nv-agent-path-section">
            <div className="nv-agent-path-info">
              <div className="nv-agent-path-label">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={16} height={16}><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                이미 설치했다면
              </div>
              <p className="nv-agent-path-desc">
                확장을 설치했는데도 이 화면이 보이면 버튼을 눌러 다시 연결하세요(새로고침).
                <br />브라우저 확장 목록에서 <b>사용 설정</b>이 켜져 있는지도 확인해 주세요.
              </p>
            </div>
            <div className="nv-agent-path-action">
              <button className="btn-outline" onClick={retry}>연결 재시도</button>
            </div>
          </div>
        </div>

        <div className="nv-agent-reassure">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} width={16} height={16}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          로그인 정보는 <b>내 브라우저에만</b> 있고 외부 서버로 전송되지 않습니다. 확장은 매물 검색·리뷰 수집에 필요한 사이트 외에는 접근하지 않습니다.
        </div>
      </div>
    </div>
  );
}
