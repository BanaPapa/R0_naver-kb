@echo off
rem KB 시계열 자동 갱신 — Windows 작업 스케줄러용 래퍼.
rem 새 파일이 있을 때만 다운로드→인제스트→발행하고, 로그를 logs\kb-update.log 에 남긴다.
chcp 65001 >nul
cd /d %~dp0..
if not exist logs mkdir logs
"C:\Program Files\nodejs\node.exe" scripts\kb-update.mjs --publish >> logs\kb-update.log 2>&1
