@echo off
chcp 65001 >nul
title 我的服务台
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 未检测到 Node.js
  echo   请先安装 Node.js 18+ ：https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo ============================================
echo   我的服务台  http://127.0.0.1:7788
echo   浏览器将自动打开；关闭本窗口即停止服务
echo ============================================
node server.js
echo.
echo 服务已停止。如刚才是报错退出，请把上方错误截图反馈。
pause
