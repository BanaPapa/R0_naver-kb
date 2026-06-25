import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import * as http from 'http';
import * as path from 'path';
import { createServer, AGENT_PORT } from './server';
import { hasCookies, clearAll, loadCookies } from './cookieStore';
import { openNaverLoginWindow } from './naverLoginWindow';
import { buildEIconPng } from './trayIcon';

let tray: Tray | null = null;
let httpServer: http.Server | null = null;

function loadTrayIcon() {
  return nativeImage.createFromBuffer(buildEIconPng());
}

function buildContextMenu(): Menu {
  const cookieOk = hasCookies();
  return Menu.buildFromTemplate([
    { label: 'Estate-OS Agent v1.0.4', enabled: false },
    { label: `포트: ${AGENT_PORT}`, enabled: false },
    {
      label: cookieOk ? '네이버: 로그인됨 ✓' : '네이버: 로그인 필요',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '네이버 로그인',
      click: () => {
        openNaverLoginWindow()
          .then(() => {
            tray?.setToolTip('Estate-OS Agent — 로그인됨');
            tray?.setContextMenu(buildContextMenu());
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[Agent] 로그인 실패:', msg);
          });
      },
    },
    {
      label: '로그아웃 (쿠키 초기화)',
      click: () => {
        clearAll();
        tray?.setToolTip('Estate-OS Agent — 로그인 필요');
        tray?.setContextMenu(buildContextMenu());
      },
    },
    { type: 'separator' },
    {
      label: '웹앱 열기',
      click: () => {
        const win = new BrowserWindow({ width: 1280, height: 900 });
        win.loadURL('https://estate-os.vercel.app');
      },
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => app.quit(),
    },
  ]);
}

function startHttpServer(): void {
  const expressApp = createServer();
  httpServer = expressApp.listen(AGENT_PORT, '127.0.0.1', () => {
    console.log(`[Estate-OS Agent] HTTP 서버 시작: http://127.0.0.1:${AGENT_PORT}`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Agent] 포트 ${AGENT_PORT} 이미 사용 중. 에이전트가 이미 실행 중입니다.`);
      app.quit();
    }
  });
}

function createTray(): void {
  const icon = loadTrayIcon();
  tray = new Tray(icon);
  const loginStatus = hasCookies() ? '로그인됨' : '로그인 필요';
  tray.setToolTip(`Estate-OS Agent — ${loginStatus}`);
  tray.setContextMenu(buildContextMenu());
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  if (process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
    // 웹앱에서 estate-os-agent://launch 호출 시 자동 실행 지원
    app.setAsDefaultProtocolClient('estate-os-agent');
  }

  loadCookies(); // 디스크에서 저장된 쿠키 복구
  startHttpServer();
  createTray();
});

app.on('window-all-closed', () => {
  // 트레이앱 유지 — 아무것도 하지 않음
});

app.on('before-quit', () => {
  httpServer?.close();
  tray?.destroy();
});
