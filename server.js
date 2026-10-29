/* 我的服务台 —— 零依赖 Node.js 服务（生产加固版）
   启动：node server.js（或双击 start.bat）
   数据：data/data.json，每次请求都会重新读取，手动改文件也能生效
   加固：安全响应头 + CSP、gzip 压缩、ETag 缓存、登录防爆破、
        健康检查、优雅退出、数据备份下载、静态目录防穿越 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 7788;
const HOST = process.env.HOST || '0.0.0.0';
/* HOST=127.0.0.1 时说明前面有反代（nginx），信任它传来的真实 IP 与 HTTPS 标记；
   直接暴露 0.0.0.0 时不信任这些头，防伪造。也可用 TRUST_PROXY=1 强制开启 */
const TRUST_PROXY = HOST === '127.0.0.1' || process.env.TRUST_PROXY === '1';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LEDGER_FILE = path.join(ROOT, '服务台账.md');

const CATEGORIES = ['checkin', 'relay', 'vps', 'game', 'domain', 'idle'];
const SESSION_MS = 30 * 86400 * 1000;
const GZIP_MIN = 1024; // 超过 1KB 且客户端支持时才压缩

/* ---------- 安全响应头（API 与静态文件统一加） ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/* ---------- 小工具 ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nextDay(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const check = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
async function jsonBody(req) {
  try { return JSON.parse((await readBody(req)) || '{}'); } catch { return {}; }
}
function maybeGzip(req, headers, body) {
  if (body.length >= GZIP_MIN && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    return zlib.gzipSync(body);
  }
  return body;
}
function sendJSON(req, res, status, obj, headers) {
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, SEC_HEADERS, headers || {});
  const body = maybeGzip(req, h, Buffer.from(JSON.stringify(obj), 'utf8'));
  res.writeHead(status, h);
  res.end(body);
}
/* 反代后取真实客户端 IP（仅信任代理模式） */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '?';
}

/* ---------- 登录防爆破：每 IP 10 分钟最多 10 次尝试 ---------- */
const loginHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginHits) if (now > rec.resetAt) loginHits.delete(ip);
}, 60e3).unref();
function loginThrottled(ip) {
  const now = Date.now();
  let rec = loginHits.get(ip);
  if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + 10 * 60e3 }; loginHits.set(ip, rec); }
  rec.count++;
  return rec.count > 10;
}

/* ---------- 等级 ---------- */
const LEVELS = [
  { xp: 0, t: '初出茅庐' },
  { xp: 25, t: '签到学徒' },
  { xp: 60, t: '勤奋打工人' },
  { xp: 120, t: '白嫖达人' },
  { xp: 200, t: '资产管家' },
  { xp: 320, t: '羊毛大师' },
  { xp: 480, t: '资本新贵' },
  { xp: 700, t: '签到仙人' },
  { xp: 1000, t: '资产管理大亨' },
  { xp: 1500, t: '传说管理人' }
];
function levelOf(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].xp) i++;
  const next = LEVELS[i + 1] || null;
  return {
    lv: i + 1,
    title: LEVELS[i].t,
    xp,
    nextXp: next ? next.xp : null,
    nextTitle: next ? next.t : null,
    progress: next ? Math.min(100, Math.round(((xp - LEVELS[i].xp) / (next.xp - LEVELS[i].xp)) * 100)) : 100
  };
}

/* ---------- 成就 ---------- */
const ACH_DEFS = [
  { id: 'first', icon: '🎉', name: '初次签到', desc: '完成人生第一次签到' },
  { id: 'all1', icon: '✅', name: '单日全勤', desc: '一天内签完所有每日签到服务' },
  { id: 'week', icon: '📅', name: '完美一周', desc: '连续 7 天天天全勤' },
  { id: 's7', icon: '🔥', name: '七日连签', desc: '单个服务连续签到 7 天' },
  { id: 's30', icon: '⚡', name: '三十连签', desc: '单个服务连续签到 30 天' },
  { id: 'night', icon: '🌙', name: '夜猫子', desc: '凌晨 0~5 点还在签到（隐藏成就）' },
  { id: 'c10', icon: '🗃️', name: '十件套', desc: '台账记录满 10 个服务' },
  { id: 'c30', icon: '🏦', name: '资产大户', desc: '台账记录满 30 个服务' },
  { id: 'xp100', icon: '💰', name: '百点家产', desc: '累计获得 100 点热情值' }
];
function maxRun(dates) {
  const s = [...new Set(dates)].sort();
  let best = 0, run = 0, prev = null;
  for (const d of s) {
    run = (prev && nextDay(prev) === d) ? run + 1 : 1;
    prev = d;
    if (run > best) best = run;
  }
  return best;
}
function dailyServices(data) {
  return data.services.filter((s) => s.checkinFrequency === 'daily' && s.category !== 'idle');
}
function ensureMeta(data) {
  let dirty = false;
  if (typeof data.xp !== 'number') { data.xp = 0; dirty = true; }
  if (!data.achievements || typeof data.achievements !== 'object') { data.achievements = {}; dirty = true; }
  if (!data.flags || typeof data.flags !== 'object') { data.flags = {}; dirty = true; }
  if (!data.history || typeof data.history !== 'object') {
    data.history = {};
    for (const s of data.services) {
      for (const d of (s.checkins || [])) {
        data.history[d] = data.history[d] || { c: 0 };
        data.history[d].c++;
      }
    }
    dirty = true;
  }
  return dirty;
}
function syncAchievements(data) {
  const unlocked = [];
  const award = (id) => {
    if (!data.achievements[id]) {
      data.achievements[id] = todayStr();
      data.xp += 10;
      unlocked.push(ACH_DEFS.find((a) => a.id === id));
    }
  };
  if (data.services.some((s) => (s.checkins || []).length)) award('first');
  const best = Math.max(0, ...data.services.map((s) => maxRun(s.checkins || [])));
  if (best >= 7) award('s7');
  if (best >= 30) award('s30');
  if (Object.values(data.history).some((h) => h && h.all)) award('all1');
  const allDays = Object.keys(data.history).filter((k) => data.history[k].all).sort();
  let run = 0, bestAll = 0, prev = null;
  for (const d of allDays) {
    run = (prev && nextDay(prev) === d) ? run + 1 : 1;
    prev = d;
    if (run > best) bestAll = run;
  }
  if (bestAll >= 7) award('week');
  if (data.flags.night) award('night');
  if (data.services.length >= 10) award('c10');
  if (data.services.length >= 30) award('c30');
  if (data.xp >= 100) award('xp100');
  return unlocked;
}
function metaPayload(data) {
  const t = todayStr();
  const daily = dailyServices(data);
  const best = Math.max(0, ...data.services.map((s) => maxRun(s.checkins || [])));
  return {
    username: data.username,
    xp: data.xp,
    level: levelOf(data.xp),
    passwordIsDefault: data.passwordIsDefault !== false,
    stats: {
      services: data.services.length,
      totalCheckins: data.services.reduce((n, s) => n + (s.checkins || []).length, 0),
      bestStreak: best,
      dailyTotal: daily.length,
      doneToday: daily.filter((s) => (s.checkins || []).includes(t)).length
    },
    achievements: ACH_DEFS.map((a) => ({ ...a, unlockedAt: data.achievements[a.id] || null })),
    history: data.history
  };
}
function publicServices(data) {
  return data.services.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    url: s.url,
    registeredAt: s.registeredAt,
    expiresAt: s.expiresAt,
    price: s.price,
    checkinFrequency: s.checkinFrequency,
    checkins: s.checkins || [],
    hasAccount: !!s.account,
    visits: s.visits || 0,
    sortOrder: s.sortOrder ?? 0,
    notes: s.notes || ''
  }));
}

/* ---------- 数据 ---------- */
function loadData() {
  let data = readJSON(DATA_FILE, null);
  if (!data || !Array.isArray(data.services)) {
    data = {
      username: 'jason',
      passwordHash: hashPassword('jason123'),
      xp: 0,
      achievements: {},
      flags: {},
      history: {},
      services: [
        {
          id: crypto.randomBytes(12).toString('hex'),
          name: '示例 · 某签到中转站',
          category: 'checkin',
          url: 'https://example.com',
          account: 'jason',
          secret: '',
          registeredAt: '2026-10-20',
          expiresAt: '',
          price: '',
          checkinFrequency: 'daily',
          notes: '示例数据：签到送额度。在卡片上可以编辑或删除。',
          checkins: ['2026-10-25', '2026-10-26']
        },
        {
          id: crypto.randomBytes(12).toString('hex'),
          name: '示例 · 一台 VPS',
          category: 'vps',
          url: '',
          account: 'root',
          secret: '',
          registeredAt: '2026-01-10',
          expiresAt: '2026-11-03',
          price: '$10/年',
          checkinFrequency: 'none',
          notes: '示例数据：演示 7 天内到期提醒。',
          checkins: []
        }
      ]
    };
    writeJSON(DATA_FILE, data);
  }
  ensureMeta(data);
  /* 旧数据迁移：补齐排序与访问次数字段 */
  let ndirty = false;
  data.services.forEach((s, i) => {
    if (typeof s.sortOrder !== 'number') { s.sortOrder = i; ndirty = true; }
    if (typeof s.visits !== 'number') { s.visits = 0; ndirty = true; }
  });
  if (ndirty) writeJSON(DATA_FILE, data);
  return data;
}
function loadSessions() { return readJSON(SESSIONS_FILE, {}); }
function saveSessions(sessions) {
  const cutoff = Date.now() - SESSION_MS;
  for (const k of Object.keys(sessions)) if (sessions[k].created < cutoff) delete sessions[k];
  writeJSON(SESSIONS_FILE, sessions);
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return null;
  const sessions = loadSessions();
  const rec = sessions[token];
  if (!rec || Date.now() - rec.created > SESSION_MS) return null;
  return { token, sessions };
}
function pickFields(b) {
  const out = {};
  if (typeof b.name === 'string') out.name = b.name.trim().slice(0, 100);
  if (b.category !== undefined) out.category = CATEGORIES.includes(b.category) ? b.category : 'relay';
  if (b.checkinFrequency !== undefined) out.checkinFrequency = b.checkinFrequency === 'daily' ? 'daily' : 'none';
  for (const k of ['url', 'account', 'secret', 'price', 'notes', 'registeredAt', 'expiresAt']) {
    if (typeof b[k] === 'string') out[k] = b[k].trim().slice(0, 500);
  }
  return out;
}

/* ---------- 导出 Markdown 台账 ---------- */
const mdCell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
function ledgerMarkdown(data) {
  const titles = {
    checkin: '📅 每日签到类',
    relay: '🔀 中转站 / API 站点',
    vps: '🖥️ VPS / 服务器',
    game: '🎮 游戏相关（游戏机 / 平台 / 订阅）',
    domain: '🌐 域名 / 其他订阅',
    idle: '🧟 已闲置 / 忘了干嘛的'
  };
  let md = `# 🗂️ 我的服务台账\n\n> 由「服务台」系统自动导出于 ${todayStr()}。请勿手改本文件——在系统里增删后点「导出台账」即可刷新。\n> 系统地址：http://127.0.0.1:${PORT}\n`;
  for (const cat of CATEGORIES) {
    const list = data.services.filter((s) => s.category === cat);
    md += `\n## ${titles[cat]}（${list.length}）\n\n`;
    if (!list.length) { md += '（暂无）\n'; continue; }
    md += '| 名称 | 网址/地址 | 账号 | 注册/购买 | 到期 | 签到 | 备注 |\n|---|---|---|---|---|---|---|\n';
    for (const s of list) {
      const ci = s.checkinFrequency === 'daily'
        ? (s.checkins.length ? `已签 ${s.checkins.length} 次` : '未签')
        : '—';
      md += `| ${mdCell(s.name)} | ${mdCell(s.url)} | ${mdCell(s.account)} | ${mdCell(s.registeredAt)} | ${mdCell(s.expiresAt)} | ${ci} | ${mdCell(s.notes)} |\n`;
    }
  }
  return md + '\n';
}

/* ---------- API ---------- */
async function handleAPI(req, res, pathname) {
  const send = (status, obj, headers) => sendJSON(req, res, status, obj, headers);

  /* 健康检查（监控/探活用，无需登录） */
  if (pathname === '/api/healthz' && req.method === 'GET') {
    return send(200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginThrottled(ip)) {
      console.warn(`[!] 登录过于频繁，已临时封禁：${ip}`);
      return send(429, { error: '尝试太频繁，请 10 分钟后再试' });
    }
    const body = await jsonBody(req);
    const data = loadData();
    if (body.username !== data.username || !verifyPassword(body.password, data.passwordHash)) {
      return send(401, { error: '用户名或密码不对' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const sessions = loadSessions();
    sessions[token] = { created: Date.now() };
    saveSessions(sessions);
    /* 反代 + HTTPS 时给 Cookie 加 Secure */
    const secure = TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').includes('https');
    return send(200, { ok: true, username: data.username }, {
      'Set-Cookie': `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`
    });
  }

  if (pathname === '/api/public' && req.method === 'GET') {
    const data = loadData();
    const unlocked = syncAchievements(data);
    if (unlocked.length) writeJSON(DATA_FILE, data);
    const payload = metaPayload(data);
    payload.services = publicServices(data);
    return send(200, payload);
  }

  const auth = currentUser(req);
  if (!auth) return send(401, { error: '未登录' });

  if (pathname === '/api/me' && req.method === 'GET') {
    return send(200, { username: loadData().username });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    delete auth.sessions[auth.token];
    saveSessions(auth.sessions);
    return send(200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (pathname === '/api/password' && req.method === 'POST') {
    const body = await jsonBody(req);
    const data = loadData();
    if (!verifyPassword(body.oldPassword, data.passwordHash)) return send(400, { error: '旧密码不对' });
    if (!body.newPassword || String(body.newPassword).length < 6) return send(400, { error: '新密码至少 6 位' });
    data.passwordHash = hashPassword(body.newPassword);
    data.passwordIsDefault = false;
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }
  if (pathname === '/api/export-md' && req.method === 'POST') {
    fs.writeFileSync(LEDGER_FILE, ledgerMarkdown(loadData()), 'utf8');
    return send(200, { ok: true, file: '服务台账.md' });
  }
  /* 一键备份：下载完整 data.json */
  if (pathname === '/api/backup' && req.method === 'GET') {
    const fname = `service-hub-backup-${todayStr()}.json`;
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store'
    }, SEC_HEADERS));
    return res.end(fs.readFileSync(DATA_FILE));
  }
  if (pathname === '/api/meta' && req.method === 'GET') {
    const data = loadData();
    const unlocked = syncAchievements(data);
    if (unlocked.length) writeJSON(DATA_FILE, data);
    return send(200, metaPayload(data));
  }

  if (pathname === '/api/services' && req.method === 'GET') {
    return send(200, loadData().services);
  }
  if (pathname === '/api/services' && req.method === 'POST') {
    const f = pickFields(await jsonBody(req));
    if (!f.name) return send(400, { error: '名称必填' });
    const data = loadData();
    const svc = Object.assign({
      id: crypto.randomBytes(12).toString('hex'),
      category: 'relay',
      url: '', account: '', secret: '', price: '', notes: '',
      registeredAt: todayStr(), expiresAt: '',
      checkinFrequency: 'none', checkins: [],
      visits: 0,
      sortOrder: Math.min(0, ...data.services.map((s) => s.sortOrder ?? 0)) - 1 // 新服务排最前
    }, f);
    data.services.push(svc);
    data.xp += 10; // 记录新服务 +10 热情值
    const unlocked = syncAchievements(data);
    writeJSON(DATA_FILE, data);
    return send(200, { ...svc, xpGained: 10, unlocked });
  }

  /* 卡片拖拽排序持久化 */
  if (pathname === '/api/reorder' && req.method === 'POST') {
    const body = await jsonBody(req);
    if (!Array.isArray(body.ids)) return send(400, { error: '参数错误' });
    const data = loadData();
    const pos = new Map(body.ids.map((x, i) => [String(x), i]));
    data.services.forEach((s) => { if (pos.has(s.id)) s.sortOrder = pos.get(s.id); });
    writeJSON(DATA_FILE, data);
    return send(200, { ok: true });
  }

  const m = pathname.match(/^\/api\/services\/([0-9a-f]+)(\/checkin|\/uncheckin|\/visit)?$/);
  if (m) {
    const data = loadData();
    const idx = data.services.findIndex((s) => s.id === m[1]);
    if (idx < 0) return send(404, { error: '找不到该服务' });
    const svc = data.services[idx];
    const t = todayStr();
    /* 访问计数：点「前往」/标题链接时打点 */
    if (req.method === 'POST' && m[2] === '/visit') {
      svc.visits = (svc.visits || 0) + 1;
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, visits: svc.visits });
    }
    if (req.method === 'POST' && m[2] === '/checkin') {
      let xpGained = 0;
      if (!svc.checkins.includes(t)) {
        svc.checkins.push(t);
        svc.checkins.sort();
        data.history[t] = data.history[t] || { c: 0 };
        data.history[t].c++;
        if (!data.history[t].x) { xpGained += 5; data.history[t].x = 5; } // 每天首次签到才给分，防反复签退刷分
        if (new Date().getHours() < 5) data.flags.night = true;
      }
      const daily = dailyServices(data);
      const allDone = daily.length > 0 && daily.every((s) => s.checkins.includes(t));
      if (allDone && !data.history[t].all) {
        data.history[t].all = true;
        xpGained += 10; // 单日全勤奖励
      }
      data.xp += xpGained;
      const unlocked = syncAchievements(data);
      writeJSON(DATA_FILE, data);
      return send(200, {
        ok: true, checkins: svc.checkins, xpGained, allDone,
        unlocked, xp: data.xp, level: levelOf(data.xp)
      });
    }
    if (req.method === 'POST' && m[2] === '/uncheckin') {
      svc.checkins = svc.checkins.filter((d) => d !== t);
      if (data.history[t]) data.history[t].c = Math.max(0, (data.history[t].c || 1) - 1);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true, checkins: svc.checkins });
    }
    if (req.method === 'PUT' && !m[2]) {
      Object.assign(svc, pickFields(await jsonBody(req)));
      writeJSON(DATA_FILE, data);
      return send(200, svc);
    }
    if (req.method === 'DELETE' && !m[2]) {
      data.services.splice(idx, 1);
      writeJSON(DATA_FILE, data);
      return send(200, { ok: true });
    }
  }
  return send(404, { error: '接口不存在' });
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.md', '.map']);
function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch {
    res.writeHead(400, SEC_HEADERS);
    return res.end('Bad Request');
  }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  /* 防目录穿越：必须落在 public/ 内部 */
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SEC_HEADERS);
    return res.end('Forbidden');
  }
  let st = null;
  try { st = fs.statSync(file); } catch {}
  if (!st || !st.isFile()) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SEC_HEADERS));
    return res.end('404 Not Found');
  }
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  const h = Object.assign({
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'ETag': etag,
    'Cache-Control': 'no-cache' // 每次都带 ETag 校验，内容没变就 304，更新即时生效
  }, SEC_HEADERS);
  if (ext === '.html') h['Content-Security-Policy'] = CSP;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, h);
    return res.end();
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, h);
    return res.end();
  }
  let body = fs.readFileSync(file);
  if (COMPRESSIBLE.has(ext)) body = maybeGzip(req, h, body);
  res.writeHead(200, h);
  res.end(body);
}

/* ---------- 启动 ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) return await handleAPI(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(req, res, 405, { error: 'Method Not Allowed' });
    }
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[!] 请求处理异常:', e);
    try { sendJSON(req, res, 500, { error: '服务器错误' }); } catch {}
  }
});
/* 防慢速攻击（Slowloris） */
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[!] 端口 ${PORT} 被占用——服务台可能已经在运行，直接打开 http://127.0.0.1:${PORT} 即可。`);
    process.exit(1);
  }
  throw e;
});

/* 优雅退出：systemd stop / Ctrl+C 时先收完存量请求再退出 */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[*] 收到 ${sig}，正在优雅退出…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[!] 未处理的 Promise 异常:', e));

loadData();
server.listen(PORT, HOST, () => {
  console.log('============================================');
  console.log(`  ✅ 我的服务台已启动  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  反代模式: ${TRUST_PROXY ? '开（信任 X-Forwarded-*）' : '关（直连）'}`);
  console.log('  Ctrl+C 停止服务');
  console.log('============================================');
  if (process.env.NO_OPEN !== '1' && process.platform === 'win32') {
    exec(`start "" "http://127.0.0.1:${PORT}"`);
  }
});
