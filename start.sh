#!/usr/bin/env bash
# 我的服务台 · Linux 启动脚本（前台运行，Ctrl+C 停止；常驻请用 systemd，见 DEPLOY.md）
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[!] 未检测到 Node.js，请先安装（建议 18+）：https://nodejs.org"
  exit 1
fi
PORT="${PORT:-7788}"
echo "============================================"
echo "  我的服务台  http://127.0.0.1:${PORT}"
echo "  Ctrl+C 停止服务"
echo "============================================"
exec node server.js
