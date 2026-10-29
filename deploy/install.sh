#!/usr/bin/env bash
# ============================================================
#  我的服务台 · Linux 一键部署 / 升级脚本
#
#  用法（在服务器上以 root 执行）：
#    cd /opt/service-hub
#    bash deploy/install.sh                  # 直连部署（监听 0.0.0.0:7788）
#    bash deploy/install.sh --port 8080     # 自定义端口
#    bash deploy/install.sh --nginx         # 同时装 nginx 反代（只监听本机）
#    bash deploy/install.sh --nginx --domain hub.example.com
#
#  特性：
#   · 自动识别 Debian/Ubuntu(apt) 与 CentOS/RHEL/Rocky/Alma(dnf/yum)
#   · 自动安装 Node.js 20（已装 18+ 则跳过）
#   · 升级前自动备份线上 data.json（保留最近 10 份）
#   · 幂等：重复执行 = 升级，data/ 数据目录不受影响
#   · systemd 低权限用户 + 沙箱加固 + 开机自启 + 崩溃重启
#   · 部署后健康检查（失败自动回滚提示 + 打印日志）
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/service-hub}"
APP_USER="${APP_USER:-servicehub}"
SERVICE="service-hub"
PORT="${PORT:-7788}"
BEHIND_NGINX=0
SETUP_NGINX=0
SERVER_NAME="_"
NODE_MIN_MAJOR=18
NODE_SETUP=20

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="/opt/service-hub-backups"

c_info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[32m ✔\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()    { printf '\033[31m[✘]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
我的服务台 · Linux 部署脚本

  bash deploy/install.sh [选项]

选项：
  --port <端口>        监听端口，默认 7788
  --nginx              安装并配置 nginx 反向代理（服务只监听 127.0.0.1）
  --domain <域名>      配合 --nginx 指定 server_name，默认 "_"（匹配任意）
  --behind-nginx       已在用 nginx，仅让服务监听 127.0.0.1（不装 nginx）
  -h, --help           显示本帮助

示例：
  bash deploy/install.sh --nginx --domain hub.example.com
  bash deploy/install.sh --port 8080
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)          [ -n "${2:-}" ] || die "--port 需要参数"; PORT="$2"; shift 2 ;;
    --nginx)         SETUP_NGINX=1; BEHIND_NGINX=1; shift ;;
    --behind-nginx)  BEHIND_NGINX=1; shift ;;
    --domain)        [ -n "${2:-}" ] || die "--domain 需要参数"; SERVER_NAME="$2"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done
case "$PORT" in *[!0-9]*) die "端口必须是数字：$PORT" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口超出范围：$PORT"

# ---------- 0. 前置检查 ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo -i 后再执行，或 sudo bash deploy/install.sh"
[ -d "$SRC_DIR/public" ] && [ -f "$SRC_DIR/server.js" ] || die "源码目录不完整：$SRC_DIR"
[ -d /run/systemd/system ] || die "未检测到 systemd（容器/WSL 环境请用 bash start.sh 前台运行）"

if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
elif command -v yum >/dev/null 2>&1; then PM=yum
else die "不支持的发行版（仅支持 apt / dnf / yum）"
fi

pkg_install() {
  case "$PM" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get update -qq
         DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
  esac
}

# ---------- 1. Node.js ----------
c_info "[1/7] 检查 Node.js"
node_major() { node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }

if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]; then
  c_ok "已安装 Node.js $(node -v)，跳过安装"
else
  if command -v node >/dev/null 2>&1; then
    c_warn "当前 Node.js $(node -v) 低于 v${NODE_MIN_MAJOR}，升级中…"
  else
    c_warn "未检测到 Node.js，安装 Node.js ${NODE_SETUP}.x…"
  fi
  pkg_install curl ca-certificates
  case "$PM" in
    apt) NODESOURCE_URL="https://deb.nodesource.com/setup_${NODE_SETUP}.x" ;;
    *)   NODESOURCE_URL="https://rpm.nodesource.com/setup_${NODE_SETUP}.x" ;;
  esac
  curl -fsSL "$NODESOURCE_URL" | bash - ||
    die "添加 NodeSource 源失败（检查服务器能否访问外网），或手动安装 Node.js v${NODE_MIN_MAJOR}+ 后重试"
  pkg_install nodejs
  [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ] || die "Node.js 安装失败，请手动安装 v${NODE_MIN_MAJOR}+ 后重试"
  c_ok "已安装 Node.js $(node -v)"
fi
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || die "找不到 node 可执行文件"

# ---------- 2. 运行依赖（rsync / curl） ----------
c_info "[2/7] 检查 rsync / curl"
command -v rsync >/dev/null 2>&1 || pkg_install rsync
command -v curl  >/dev/null 2>&1 || pkg_install curl
c_ok "rsync / curl 就绪"

# ---------- 3. 低权限运行用户 ----------
c_info "[3/7] 创建运行用户 ${APP_USER}"
NOLOGIN=/usr/sbin/nologin
[ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
if id -u "$APP_USER" >/dev/null 2>&1; then
  c_ok "用户已存在"
else
  useradd --system --no-create-home --shell "$NOLOGIN" "$APP_USER"
  c_ok "用户已创建"
fi

# ---------- 4. 备份 + 同步文件 ----------
c_info "[4/7] 同步文件到 ${APP_DIR}（保留 data/）"
mkdir -p "$APP_DIR" "$BACKUP_DIR"
if [ -f "$APP_DIR/data/data.json" ]; then
  BAK="$BACKUP_DIR/data-$(date +%Y%m%d-%H%M%S).json"
  cp -p "$APP_DIR/data/data.json" "$BAK"
  c_ok "已备份线上数据 → $BAK"
  ls -1t "$BACKUP_DIR"/data-*.json 2>/dev/null | tail -n +11 | xargs -r rm -f || true
fi
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rsync -a --delete \
    --exclude 'data/' --exclude '.git/' --exclude 'node_modules/' \
    "$SRC_DIR/" "$APP_DIR/"
  c_ok "文件已同步"
else
  c_ok "已在目标目录，跳过同步"
fi
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 750 "$APP_DIR/data"
# 数据文件含账号密码，收紧到仅属主可读写
find "$APP_DIR/data" -type f -exec chmod 600 {} + 2>/dev/null || true
c_ok "目录权限已设置（${APP_USER} 独占）"

# ---------- 5. systemd 服务 ----------
c_info "[5/7] 安装 systemd 服务 ${SERVICE}"
UNIT_SRC="$APP_DIR/deploy/service-hub.service"
[ -f "$UNIT_SRC" ] || die "缺少服务模板：$UNIT_SRC"
SED_ARGS=(
  -e "s|^ExecStart=.*|ExecStart=${NODE_BIN} server.js|"
  -e "s|^Environment=PORT=.*|Environment=PORT=${PORT}|"
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|"
  -e "s|^ReadWritePaths=.*|ReadWritePaths=${APP_DIR}|"
)
if [ "$BEHIND_NGINX" -eq 1 ]; then
  SED_ARGS+=(-e "s|^#Environment=HOST=127.0.0.1|Environment=HOST=127.0.0.1|")
fi
sed "${SED_ARGS[@]}" "$UNIT_SRC" > "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
c_ok "服务已启动并设置开机自启"

# ---------- 6. 健康检查 ----------
c_info "[6/7] 健康检查"
HEALTH_URL="http://127.0.0.1:${PORT}/api/healthz"
OK=0
for _ in $(seq 1 15); do
  if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  c_warn "健康检查未通过，最近日志："
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "服务启动失败。常见原因：端口 ${PORT} 被占用 / data/data.json 权限异常"
fi
c_ok "健康检查通过（$HEALTH_URL）"

# ---------- 7. 可选：nginx 反代 ----------
if [ "$SETUP_NGINX" -eq 1 ]; then
  c_info "[7/7] 安装并配置 nginx 反向代理"
  # 未指定域名时用本机主网卡 IP，避免与 nginx 默认站点抢 Host 匹配
  if [ "$SERVER_NAME" = "_" ]; then
    SERVER_NAME="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$SERVER_NAME" ] || SERVER_NAME="_"
  fi
  command -v nginx >/dev/null 2>&1 || pkg_install nginx
  NGINX_SRC="$APP_DIR/deploy/nginx.conf"
  [ -f "$NGINX_SRC" ] || die "缺少 nginx 模板：$NGINX_SRC"
  TMP_CONF="$(mktemp)"
  sed -e "s|^    server_name .*|    server_name ${SERVER_NAME};|" \
      -e "s|127.0.0.1:7788|127.0.0.1:${PORT}|g" \
      "$NGINX_SRC" > "$TMP_CONF"
  if [ -d /etc/nginx/sites-available ]; then
    install -m 644 "$TMP_CONF" /etc/nginx/sites-available/service-hub
    ln -sf /etc/nginx/sites-available/service-hub /etc/nginx/sites-enabled/service-hub
  else
    install -m 644 "$TMP_CONF" /etc/nginx/conf.d/service-hub.conf
  fi
  rm -f "$TMP_CONF"
  nginx -t || die "nginx 配置语法错误，请检查 /etc/nginx/ 下的 service-hub 配置"
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  c_ok "nginx 已启用（仅 80/443 对外，应用端口只监听本机）"
else
  c_info "[7/7] 跳过 nginx（未指定 --nginx）"
fi

# ---------- 完成 ----------
echo
echo "============================================"
echo "  ✅ 部署完成"
echo "     运行用户 : ${APP_USER}（低权限）"
if [ "$BEHIND_NGINX" -eq 1 ]; then
  echo "     监听端口 : ${PORT}（仅 127.0.0.1，对外走 nginx）"
else
  echo "     监听端口 : ${PORT}（0.0.0.0，需在防火墙/安全组放行）"
fi
echo "     数据目录 : ${APP_DIR}/data（已备份至 ${BACKUP_DIR}）"
if [ "$SETUP_NGINX" -eq 1 ]; then
  echo "     访问地址 : http://${SERVER_NAME}/"
else
  echo "     访问地址 : http://服务器IP:${PORT}/"
fi
echo
echo "  常用命令："
echo "    systemctl status ${SERVICE}          # 状态"
echo "    systemctl restart ${SERVICE}         # 重启"
echo "    journalctl -u ${SERVICE} -f          # 实时日志"
echo "    curl http://127.0.0.1:${PORT}/api/healthz   # 健康检查"
echo
echo "  ⚠ 第一件事：打开页面登录后点「改密码」"
echo "============================================"
