'use strict';

const CATS = {
  checkin: { label: '每日签到', icon: '📅', cls: 't-checkin' },
  relay:   { label: '中转站/API', icon: '🔀', cls: 't-relay' },
  vps:     { label: 'VPS/服务器', icon: '🖥️', cls: 't-vps' },
  game:    { label: '游戏', icon: '🎮', cls: 't-game' },
  domain:  { label: '域名/订阅', icon: '🌐', cls: 't-domain' },
  idle:    { label: '已闲置', icon: '🧟', cls: 't-idle' }
};

const YI = ['签到领奖励', '整理一遍台账', '检查 VPS 状态', '白嫖积分', '续费该续的', '注册个新的试试', '早点睡', '给账号改个强密码'];
const JI = ['忘签到', '熬夜', '乱点链接', '乱花钱', '拖延症', '忘记续费'];
const QUOTES = [
  '坚持签到的人，运气都不会太差。',
  '你签的不是到，是白嫖的尊严。',
  '资产不怕多，就怕忘了它。',
  '今天的签到，是明天的底气。',
  '每一台 VPS 都值得被记住。',
  '稳定的续费，源于记录的坚持。',
  '台账记得越全，钱包越稳。',
  '签到一时爽，一直签一直爽。',
  '白嫖的最高境界：一个都不漏。',
  '机器在替你打工，你要替机器记账。',
  '别让任何一个账号，变成失联的旧爱。',
  '每天一分钟，资产不失控。'
];

let mode = 'preview', me = null, services = [], meta = null, filter = 'all', q = '', editingId = null;
const live = () => mode === 'live';

const $ = (sel) => document.querySelector(sel);
const RING_C = 2 * Math.PI * 52;

/* ---------- 工具 ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  const target = new Date(y, m - 1, d);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - base) / 86400e3);
}
function streak(dates) {
  const set = new Set(dates || []);
  if (!set.size) return 0;
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let d = new Date();
  if (!set.has(fmt(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(fmt(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function maxRun(dates) {
  const s = [...new Set(dates || [])].sort();
  let best = 0, run = 0, prev = null;
  for (const d of s) {
    const [y, m, dd] = d.split('-').map(Number);
    if (prev) {
      const pd = new Date(prev[0], prev[1] - 1, prev[2] + 1);
      const same = pd.getFullYear() === y && pd.getMonth() === m - 1 && pd.getDate() === dd;
      run = same ? run + 1 : 1;
    } else run = 1;
    prev = [y, m, dd];
    if (run > best) best = run;
  }
  return best;
}
function hashDay(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2400);
}
function confetti(n = 70) {
  const colors = ['#5b8cff', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#c084fc', '#ffd479'];
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'confetti';
    d.style.left = Math.random() * 100 + 'vw';
    d.style.background = colors[Math.floor(Math.random() * colors.length)];
    d.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
    d.style.animationDelay = (Math.random() * 0.5) + 's';
    d.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3600);
  }
}
function openLogin() {
  $('#l-err').classList.add('hidden');
  $('#login-overlay').classList.remove('hidden');
  $('#l-user').focus();
}
function handleAuthErr(err) {
  if (err.message === '请先登录') openLogin();
  else toast(err.message, 'bad');
}
async function api(url, opts = {}) {
  const res = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  if (res.status === 401) throw new Error('请先登录');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

/* ---------- 数据 ---------- */
async function loadAll() {
  [services, meta] = await Promise.all([api('/api/services'), api('/api/meta')]);
  me = { username: meta.username };
  mode = 'live';
  renderAll();
}
async function loadPreview() {
  const pub = await fetch('/api/public').then((r) => { if (!r.ok) throw new Error('fail'); return r.json(); });
  services = pub.services;
  meta = pub;
  me = { username: pub.username };
  mode = 'preview';
  renderAll();
}

/* ---------- 渲染 ---------- */
function renderAll() {
  /* 按用户拖拽顺序排列（无顺序数据时保持现状） */
  services.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  document.body.classList.toggle('mode-live', live());
  document.body.classList.toggle('mode-preview', !live());

  const d = new Date();
  const t = todayStr();
  const daily = services.filter((s) => s.checkinFrequency === 'daily' && s.category !== 'idle');
  const done = daily.filter((s) => (s.checkins || []).includes(t)).length;
  const soon = services.filter((s) => s.expiresAt && daysUntil(s.expiresAt) <= 7).length;
  const best = Math.max(0, ...services.map((s) => maxRun(s.checkins)));
  const total = services.reduce((n, s) => n + (s.checkins || []).length, 0);
  const lv = meta.level;
  const h = d.getHours();
  const hello = h < 6 ? '夜深了' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 23 ? '晚上好' : '夜深了';

  // 全勤 pill
  const allDays = Object.keys(meta.history || {}).filter((k) => meta.history[k] && meta.history[k].all);
  const allStreak = streak(allDays);
  $('#streak-pill-text').textContent = allStreak >= 2 ? `已连续全勤 ${allStreak} 天` : `今日 ${done}/${daily.length} 已签`;

  // 大标题下的副标题
  $('#sub-line').textContent = live()
    ? `${me.username}，${hello}！${daily.length && done < daily.length ? `还有 ${daily.length - done} 个站等着你签到 · ` : ''}已收录 ${services.length} 个服务，累计签到 ${total} 次。`
    : `中转站、VPS、游戏机、订阅全记在这，签到额度一个不漏。已收录 ${services.length} 个服务 · 累计签到 ${total} 次，登录后可签到和编辑。`;

  // 运势
  const hs = hashDay(t);
  const stars = 2 + (hs % 4);
  const yi1 = YI[hs % YI.length];
  const yi2 = YI[(hs >> 3) % YI.length];
  const ji = JI[(hs >> 6) % JI.length];
  $('#fortune-pill').textContent = '🔮 今日运势 ' + '⭐'.repeat(stars);
  $('#yi-line').textContent = `宜：${yi1}、${yi2}`;
  $('#ji-line').textContent = `忌：${ji}`;
  typewrite($('#quote-line'), `「${QUOTES[hs % QUOTES.length]}」`);

  // 进度环
  $('#ring-text').textContent = `${done}/${daily.length}`;
  const pct = daily.length ? done / daily.length : 0;
  const fg = $('#ring-fg');
  fg.style.strokeDashoffset = RING_C * (1 - pct);
  fg.classList.toggle('full', daily.length > 0 && done === daily.length);

  // 等级徽章 & 侧栏用户卡
  $('#level-pill').textContent = `⚡ Lv.${lv.lv} ${lv.title}`;
  $('#level-pill').title = `热情值 ${lv.xp}` +
    (lv.nextXp ? ` / ${lv.nextXp}，还差 ${lv.nextXp - lv.xp} 点升级到「${lv.nextTitle}」` : '（已满级，传说就是你）');
  const av = $('#avatar');
  if (av) av.textContent = (me.username || '?').trim().slice(0, 1).toUpperCase();
  const xpb = $('#xp-bar-in');
  if (xpb) {
    xpb.style.width = `${lv.progress}%`;
    xpb.parentElement.title = lv.nextXp ? `热情值 ${lv.xp} / ${lv.nextXp}（${lv.progress}%）` : '已满级';
  }

  // 统计条（数字滚动）
  countUp($('#ss-streak'), best);
  countUp($('#ss-total'), total);
  countUp($('#ss-services'), services.length);
  countUp($('#ss-xp'), lv.xp);

  // 一键全签按钮
  const b = $('#btn-check-all');
  if (!daily.length) { b.classList.add('hidden'); }
  else {
    b.classList.remove('hidden');
    if (done === daily.length) { b.textContent = '今日已全签 ✓'; b.disabled = true; }
    else { b.textContent = '⚡ 一键全签'; b.disabled = false; }
  }

  $('#stats').textContent = `共 ${services.length} 个服务 · 今日已签 ${done}/${daily.length} · 7天内到期 ${soon}`;
  $('#checkin-progress').textContent = daily.length ? `今日已签 ${done}/${daily.length}` : '';
  $('#checkin-bar').style.width = daily.length ? `${(done / daily.length) * 100}%` : '0';

  renderBanner();
  const sb = $('#sec-banner');
  if (live() && meta.passwordIsDefault) {
    sb.innerHTML = '🔒 当前还是初始默认密码，部署到服务器前务必点右上角「改密码」换掉！';
    sb.classList.remove('hidden');
  } else sb.classList.add('hidden');
  renderCheckin();
  renderHeatmap();
  renderAch();
  renderChips();
  renderGrid();
  drawTrend();
}

function renderBanner() {
  const soon = services
    .filter((s) => s.expiresAt)
    .map((s) => ({ s, d: daysUntil(s.expiresAt) }))
    .filter((x) => x.d <= 7)
    .sort((a, b) => a.d - b.d);
  const el = $('#expiry-banner');
  if (!soon.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = soon.map(({ s, d }) => {
    const cls = d < 0 ? 'bad' : '';
    const txt = d < 0 ? `已过期 ${-d} 天` : (d === 0 ? '今天到期' : `${d} 天后到期`);
    return `<span class="expiry-item ${cls}">⏰ <b>${esc(s.name)}</b> ${txt}（${esc(s.expiresAt)}）</span>`;
  }).join('');
}

function renderCheckin() {
  const list = services.filter((s) => s.checkinFrequency === 'daily' && s.category !== 'idle');
  const box = $('#checkin-list');
  if (!list.length) {
    box.innerHTML = `<div class="empty">还没有需要每日签到的服务。${live() ? '点右上角「➕ 添加服务」，把「签到频率」设为「每天」就会出现在这里。' : '登录后添加，把「签到频率」设为「每天」即可。'}</div>`;
    return;
  }
  const t = todayStr();
  box.innerHTML = list.map((s) => {
    const ok = (s.checkins || []).includes(t);
    const st = streak(s.checkins);
    const last = (s.checkins || []).length ? s.checkins[s.checkins.length - 1] : '从未签到';
    const right = live()
      ? (ok
        ? `<button class="btn ok" data-act="uncheckin" data-id="${s.id}" title="点一下可撤销今天的签到">✓ 今日已签</button>`
        : `<button class="btn primary" data-act="checkin" data-id="${s.id}">签到 +5⚡</button>`)
      : `<button class="btn ghost" data-act="wantlogin">🔒 登录后签到</button>`;
    return `<div class="checkin-row">
      <div class="ci-info">
        <div class="ci-name">${esc(s.name)} ${st ? `<span class="chip fire">🔥 连续${st}天</span>` : ''}</div>
        <div class="ci-sub">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : '未填网址'} · 上次：${esc(last)}</div>
      </div>
      ${right}
    </div>`;
  }).join('');
}

function renderHeatmap() {
  const el = $('#heatmap');
  const hist = meta.history || {};
  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setDate(start.getDate() - (dow + 77));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let html = '';
  for (let w = 0; w < 12; w++) {
    html += '<div class="hm-col">';
    for (let r = 0; r < 7; r++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + r);
      if (d > today) { html += '<div class="hm-cell hm-future"></div>'; continue; }
      const key = fmt(d);
      const c = (hist[key] && hist[key].c) || 0;
      const cls = c >= 4 ? 'hm-4' : (c >= 2 ? 'hm-2' : (c === 1 ? 'hm-1' : ''));
      html += `<div class="hm-cell ${cls}" title="${key} · 签到 ${c} 次"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderAch() {
  const list = meta.achievements || [];
  const un = list.filter((a) => a.unlockedAt).length;
  $('#ach-count').textContent = `${un}/${list.length} 已解锁 · 解锁各 +10⚡`;
  $('#ach-grid').innerHTML = list.map((a) => `<div class="ach ${a.unlockedAt ? '' : 'locked'}" title="${esc(a.unlockedAt ? '解锁于 ' + a.unlockedAt : '还没解锁：' + a.desc)}">
    <div class="a-ico">${a.unlockedAt ? a.icon : '🔒'}</div>
    <div class="a-name">${esc(a.name)}</div>
    <div class="a-desc">${esc(a.desc)}</div>
    ${a.unlockedAt ? `<div class="a-date">🎉 ${esc(a.unlockedAt)}</div>` : ''}
  </div>`).join('');
}

function renderChips() {
  const counts = {};
  services.forEach((s) => { counts[s.category] = (counts[s.category] || 0) + 1; });
  const mk = (key, label, count) =>
    `<button class="chip ${filter === key ? 'on' : ''}" data-cat="${key}">${label} <i>${count}</i></button>`;
  let html = mk('all', '全部', services.length);
  for (const [k, v] of Object.entries(CATS)) html += mk(k, `${v.icon} ${v.label}`, counts[k] || 0);
  $('#chips').innerHTML = html;
}

function cardBold(s) {
  if (s.notes) return s.notes.split(/\r?\n/)[0];
  if (s.checkinFrequency === 'daily') return '每日签到送奖励，坚持别断';
  if (s.expiresAt) {
    const d = daysUntil(s.expiresAt);
    return `到期 ${s.expiresAt}${d !== null ? `（剩 ${d} 天）` : ''}`;
  }
  return '点击标题直达官网';
}

function cardHTML(s, idx) {
  const cat = CATS[s.category] || CATS.relay;
  const num = String(idx + 1).padStart(2, '0');
  const d = daysUntil(s.expiresAt);
  const st = streak(s.checkins);
  const checkedToday = live() && (s.checkins || []).includes(todayStr());
  let exp = '';
  if (d !== null) {
    let badge, cls;
    if (d < 0) { badge = `已过期${-d}天`; cls = 'b-bad'; }
    else if (d <= 7) { badge = d === 0 ? '今天到期' : `${d}天后到期`; cls = 'b-warn'; }
    else { badge = `剩${d}天`; cls = 'b-ok'; }
    exp = `<span class="badge ${cls}">⏰ ${badge}</span>`;
  }
  const bold = cardBold(s);
  const noteLines = (s.notes || '').split(/\r?\n/).slice(1).filter(Boolean);
  const metaLine = [
    s.registeredAt ? `注册 ${esc(s.registeredAt)}` : '',
    s.expiresAt ? `到期 ${esc(s.expiresAt)}` : '',
    s.price ? esc(s.price) : '',
    s.hasAccount ? '账号已录 🔒' : ''
  ].filter(Boolean).join(' · ') || (live() ? '补个账号备注吧' : '登录后可补全信息');

  const actions = live()
    ? `<div class="card-acts">
        ${s.checkinFrequency === 'daily' && s.category !== 'idle'
          ? `<button class="btn small ${checkedToday ? 'ok' : 'primary'}" data-act="${checkedToday ? 'uncheckin' : 'checkin'}" data-id="${s.id}">${checkedToday ? '✓ 已签' : '签到'}</button>` : ''}
        <button class="btn small ghost" data-act="edit" data-id="${s.id}">编辑</button>
        <button class="btn small ghost" data-act="del" data-id="${s.id}">删除</button>
      </div>`
    : (s.checkinFrequency === 'daily' && s.category !== 'idle'
      ? `<div class="card-acts"><button class="btn small ghost" data-act="wantlogin">🔒 登录后签到</button></div>` : '');

  return `<div class="card" data-id="${s.id}">
    <span class="ghost-num">${num}</span>
    <div class="c-head">
      <span class="cat-pill ${cat.cls}"><i></i>${cat.icon} ${cat.label}</span>
      <span class="c-badges">${s.visits ? `<span class="badge b-visit" title="累计访问 ${s.visits} 次">👆 ${s.visits}</span>` : ''}${exp}${st ? `<span class="badge b-fire">🔥 连${st}天</span>` : ''}${checkedToday ? '<span class="badge b-ok">今日已签</span>' : ''}</span>
    </div>
    <div class="c-title">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" data-visit="${s.id}">${esc(s.name)} <span class="arrow">↗</span></a>` : esc(s.name)}</div>
    <div class="c-desc">${esc(bold)}</div>
    <div class="c-div"></div>
    <div class="c-note">${metaLine}</div>
    ${noteLines.map((l) => `<div class="c-note">${esc(l)}</div>`).join('')}
    ${actions}
  </div>`;
}

function renderGrid() {
  const kw = q.trim().toLowerCase();
  const list = services.filter((s) => {
    if (filter !== 'all' && s.category !== filter) return false;
    if (kw) {
      const hay = `${s.name} ${s.account || ''} ${s.url} ${s.notes} ${s.secret || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const grid = $('#grid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty">没有匹配的服务。${live() ? '点「➕ 添加服务」把它们都记下来吧。' : '登录后就可以记录了。'}</div>`;
    return;
  }
  const groups = filter === 'all' ? Object.keys(CATS) : [filter];
  let html = '', counter = 0;
  for (const cat of groups) {
    const items = list.filter((s) => s.category === cat);
    if (!items.length) continue;
    html += `<h2 class="sec-title">${CATS[cat].icon} ${CATS[cat].label} <i>${items.length}</i></h2><div class="cards">`;
    html += items.map((s) => cardHTML(s, counter++)).join('');
    html += '</div>';
  }
  grid.innerHTML = html;
  /* 入场交错动画 + 登录后可拖拽排序 */
  const searching = document.activeElement === $('#search');
  grid.querySelectorAll('.card').forEach((el, i) => {
    el.draggable = live();
    if (!searching && !reduceMotion) {
      el.style.animationDelay = `${Math.min(i * 45, 450)}ms`;
      el.classList.add('reveal-in');
    }
  });
}

/* ---------- 弹窗 ---------- */
function openModal(svc) {
  editingId = svc ? svc.id : null;
  $('#modal-title').textContent = svc ? '编辑服务' : '添加服务';
  $('#f-name').value = svc?.name || '';
  $('#f-category').value = svc?.category || 'relay';
  $('#f-url').value = svc?.url || '';
  $('#f-account').value = svc?.account || '';
  $('#f-secret').value = svc?.secret || '';
  $('#f-registered').value = svc?.registeredAt || todayStr();
  $('#f-expires').value = svc?.expiresAt || '';
  $('#f-price').value = svc?.price || '';
  $('#f-frequency').value = svc?.checkinFrequency || 'none';
  $('#f-notes').value = svc?.notes || '';
  $('#overlay').classList.remove('hidden');
  $('#f-name').focus();
}
function closeModal() {
  $('#overlay').classList.add('hidden');
  editingId = null;
}

/* ---------- 事件 ---------- */
document.body.addEventListener('click', async (e) => {
  /* 访问统计：点标题链接打点计数（不拦截跳转） */
  const vEl = e.target.closest('[data-visit]');
  if (vEl) {
    const s = services.find((x) => x.id === vEl.dataset.visit);
    if (s && live()) {
      s.visits = (s.visits || 0) + 1;
      api(`/api/services/${s.id}/visit`, { method: 'POST' }).catch(() => {});
      const badge = vEl.closest('.card')?.querySelector('.b-visit');
      if (badge) badge.textContent = `👆 ${s.visits}`;
      else renderGrid();
    }
    return;
  }

  const chip = e.target.closest('[data-cat]');
  if (chip) { filter = chip.dataset.cat; renderChips(); renderGrid(); return; }

  const cp = e.target.closest('[data-copy]');
  if (cp) { await copyText(cp.dataset.copy); toast('已复制'); return; }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;

  try {
    if (act === 'wantlogin') { openLogin(); return; }
    if (act === 'checkin' || act === 'uncheckin') {
      const r = await api(`/api/services/${id}/${act}`, { method: 'POST' });
      if (act === 'checkin') {
        if (r.xpGained > 0) toast(`+${r.xpGained} 热情值 ⚡`, 'gold');
        if (r.allDone) { confetti(90); setTimeout(() => toast('🎉 今日全勤达成！奖励 +10⚡', 'gold'), 900); }
        if (r.unlocked && r.unlocked.length) {
          confetti(110);
          setTimeout(() => toast(`🏆 解锁成就：${r.unlocked.map((a) => `${a.icon} ${a.name}`).join('、')}（+10⚡）`, 'gold'), 1800);
        }
      }
      await loadAll();
    } else if (act === 'edit') {
      openModal(services.find((s) => s.id === id));
    } else if (act === 'del') {
      const svc = services.find((s) => s.id === id);
      if (confirm(`确定删除「${svc ? svc.name : ''}」？删除后不可恢复。`)) {
        await api(`/api/services/${id}`, { method: 'DELETE' });
        await loadAll();
        toast('已删除');
      }
    } else if (act === 'reveal') {
      const el = document.querySelector(`[data-secret-id="${id}"]`);
      if (el) {
        if (el.dataset.shown === '1') { el.textContent = '••••••'; el.dataset.shown = ''; }
        else { el.textContent = el.dataset.v; el.dataset.shown = '1'; }
      }
    }
  } catch (err) { handleAuthErr(err); }
});

$('#btn-check-all').addEventListener('click', async () => {
  const t = todayStr();
  const todo = services.filter((s) => s.checkinFrequency === 'daily' && s.category !== 'idle' && !(s.checkins || []).includes(t));
  if (!todo.length) return;
  const btn = $('#btn-check-all');
  btn.disabled = true;
  btn.textContent = '签到中…';
  let sum = 0, unlocked = [], allDone = false;
  for (const s of todo) {
    try {
      const r = await api(`/api/services/${s.id}/checkin`, { method: 'POST' });
      sum += r.xpGained || 0;
      if (r.unlocked && r.unlocked.length) unlocked.push(...r.unlocked);
      allDone = r.allDone || allDone;
    } catch {}
  }
  await loadAll();
  toast(`⚡ 一键全签完成，共 +${sum} 热情值！`, 'gold');
  if (unlocked.length || allDone) confetti(120);
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#l-err').classList.add('hidden');
  try {
    me = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#l-user').value.trim(), password: $('#l-pass').value })
    });
    $('#l-pass').value = '';
    $('#login-overlay').classList.add('hidden');
    await loadAll();
    confetti(60);
    toast(`欢迎回来，${me.username}！`, 'gold');
  } catch (err) {
    $('#l-err').textContent = err.message;
    $('#l-err').classList.remove('hidden');
  }
});

$('#btn-login').addEventListener('click', openLogin);
$('#btn-hero-login').addEventListener('click', openLogin);
$('#login-cancel').addEventListener('click', () => $('#login-overlay').classList.add('hidden'));
$('#login-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#login-overlay').classList.add('hidden'); });

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
});

$('#btn-add').addEventListener('click', () => openModal(null));
$('#modal-cancel').addEventListener('click', closeModal);
$('#overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });
$('#pass-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#pass-overlay').classList.add('hidden'); });
$('#btn-pass').addEventListener('click', () => $('#pass-overlay').classList.remove('hidden'));
$('#pass-cancel').addEventListener('click', () => $('#pass-overlay').classList.add('hidden'));

$('#modal-save').addEventListener('click', async () => {
  const isEdit = !!editingId;
  const f = {
    name: $('#f-name').value.trim(),
    category: $('#f-category').value,
    url: $('#f-url').value.trim(),
    account: $('#f-account').value.trim(),
    secret: $('#f-secret').value,
    registeredAt: $('#f-registered').value,
    expiresAt: $('#f-expires').value,
    price: $('#f-price').value.trim(),
    checkinFrequency: $('#f-frequency').value,
    notes: $('#f-notes').value.trim()
  };
  if (!f.name) return toast('名称必填', 'bad');
  try {
    let r;
    if (isEdit) r = await api(`/api/services/${editingId}`, { method: 'PUT', body: JSON.stringify(f) });
    else r = await api('/api/services', { method: 'POST', body: JSON.stringify(f) });
    closeModal();
    await loadAll();
    if (!isEdit) {
      toast(`已添加，记录新服务 +10⚡`, 'gold');
      if (r.unlocked && r.unlocked.length) { confetti(100); setTimeout(() => toast(`🏆 解锁成就：${r.unlocked.map((a) => `${a.icon} ${a.name}`).join('、')}`, 'gold'), 1200); }
    } else toast('已保存');
  } catch (err) { handleAuthErr(err); }
});

$('#pass-save').addEventListener('click', async () => {
  const o = $('#p-old').value, n = $('#p-new').value, n2 = $('#p-new2').value;
  if (n !== n2) return toast('两次新密码不一致', 'bad');
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ oldPassword: o, newPassword: n }) });
    $('#pass-overlay').classList.add('hidden');
    ['p-old', 'p-new', 'p-new2'].forEach((id) => { $('#' + id).value = ''; });
    toast('密码已修改');
  } catch (err) { handleAuthErr(err); }
});

$('#btn-export').addEventListener('click', async () => {
  try {
    await api('/api/export-md', { method: 'POST' });
    toast('已导出到 服务台账.md');
  } catch (err) { handleAuthErr(err); }
});

$('#btn-backup').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = '/api/backup';
  a.download = `service-hub-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('备份已开始下载');
});

/* ESC 关闭所有弹窗 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeModal();
  $('#login-overlay').classList.add('hidden');
  $('#pass-overlay').classList.add('hidden');
});

$('#search').addEventListener('input', (e) => { q = e.target.value; renderGrid(); });

/* ---------- 视觉特效 ---------- */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* 主题切换（霓虹紫 / 深海蓝 / 翡翠绿），粒子、进度环、趋势图全部跟随 */
const THEMES = {
  neon: { particles: ['232,121,249', '34,211,238', '167,139,250'] },
  ocean: { particles: ['56,189,248', '34,211,238', '96,165,250'] },
  emerald: { particles: ['52,211,153', '163,230,53', '45,212,191'] }
};
let particleColors = THEMES.neon.particles;
function applyTheme(name, save) {
  if (!THEMES[name]) name = 'neon';
  document.body.dataset.theme = name;
  particleColors = THEMES[name].particles;
  document.querySelectorAll('.theme-dot').forEach((d) => d.classList.toggle('on', d.dataset.theme === name));
  if (save) try { localStorage.setItem('sh-theme', name); } catch {}
  const cs = getComputedStyle(document.body);
  const g2 = cs.getPropertyValue('--g2').trim();
  const g3 = cs.getPropertyValue('--accent-2').trim();
  const stops = document.querySelectorAll('#ringGrad stop');
  if (stops[0] && g2) stops[0].setAttribute('stop-color', g2);
  if (stops[1] && g3) stops[1].setAttribute('stop-color', g3);
  drawTrend();
}
document.querySelectorAll('.theme-dot').forEach((d) =>
  d.addEventListener('click', () => applyTheme(d.dataset.theme, true)));
applyTheme((() => { try { return localStorage.getItem('sh-theme'); } catch { return null; } })() || 'neon');

/* 数字滚动 */
function countUp(el, val) {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (from === val || reduceMotion) { el.textContent = val; return; }
  const t0 = performance.now(), dur = 650;
  requestAnimationFrame(function step(t) {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(from + (val - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  });
}

/* 打字机（每日一句） */
let typeTimer = null;
function typewrite(el, text) {
  if (!el) return;
  clearInterval(typeTimer);
  if (reduceMotion) { el.textContent = text; return; }
  el.textContent = '';
  el.classList.add('typing');
  let i = 0;
  typeTimer = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) { clearInterval(typeTimer); setTimeout(() => el.classList.remove('typing'), 2000); }
  }, 45);
}

/* 签到趋势图（近 14 天柱状图，canvas 手绘，生长动画，随主题变色） */
function drawTrend() {
  const cv = document.getElementById('trend-chart');
  if (!cv || !services.length) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const days = [], counts = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push(key);
    counts.push(services.reduce((n, s) => n + ((s.checkins || []).includes(key) ? 1 : 0), 0));
  }
  const max = Math.max(1, ...counts);
  const cs = getComputedStyle(document.body);
  const g2 = cs.getPropertyValue('--g2').trim() || '#d946ef';
  const g3 = cs.getPropertyValue('--accent-2').trim() || '#22d3ee';
  const bw = W / 14, barW = Math.min(26, bw * .55), base = H - 16;
  const t0 = performance.now(), dur = 600;
  requestAnimationFrame(function tick(t) {
    const p = reduceMotion ? 1 : Math.min(1, (t - t0) / dur);
    const e2 = 1 - Math.pow(1 - p, 3);
    ctx.clearRect(0, 0, W, H);
    days.forEach((dkey, i) => {
      const h = Math.max(3, (counts[i] / max) * (H - 42) * e2);
      const x = i * bw + (bw - barW) / 2, y = base - h;
      const grad = ctx.createLinearGradient(0, y, 0, base);
      grad.addColorStop(0, i === 13 ? g3 : g2);
      grad.addColorStop(1, g3);
      ctx.globalAlpha = counts[i] ? .95 : .14;
      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, h, 5); else ctx.rect(x, y, barW, h);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (p === 1) {
        if (counts[i]) {
          ctx.fillStyle = 'rgba(240,240,255,.8)';
          ctx.font = '600 10px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(counts[i], x + barW / 2, y - 5);
        }
        if (i % 3 === 1 || i === 13) {
          ctx.fillStyle = 'rgba(150,140,190,.65)';
          ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(`${+dkey.slice(5, 7)}/${+dkey.slice(8)}`, x + barW / 2, H - 3);
        }
      }
    });
    if (p < 1) requestAnimationFrame(tick);
  });
}
addEventListener('resize', () => drawTrend());

/* 星空粒子（canvas，主题三色 + 邻近连线） */
(function starfield() {
  const cv = document.getElementById('fx');
  if (!cv || reduceMotion) return;
  const ctx = cv.getContext('2d');
  let W, H, pts;
  function resize() {
    W = cv.width = innerWidth;
    H = cv.height = innerHeight;
    const n = Math.min(90, Math.floor(W * H / 22000));
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
      r: Math.random() * 1.8 + .6,
      ci: (Math.random() * 3) | 0
    }));
  }
  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fillStyle = `rgba(${particleColors[p.ci]},.55)`;
      ctx.fill();
    }
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 13000) {
          ctx.strokeStyle = `rgba(${particleColors[2]},${(1 - d2 / 13000) * .16})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[j].x, pts[j].y);
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(tick);
  });
})();

/* 鼠标跟随光球（screen 混合模式，柔光扫过页面） */
(function cursorGlow() {
  const g = document.getElementById('cursor-glow');
  if (!g || reduceMotion) return;
  let tx = innerWidth * .6, ty = innerHeight * .3, x = tx, y = ty;
  document.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; });
  requestAnimationFrame(function tick() {
    x += (tx - x) * .07; y += (ty - y) * .07;
    g.style.transform = `translate(${x - 160}px, ${y - 160}px)`;
    requestAnimationFrame(tick);
  });
})();

/* 按钮涟漪 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn, .chip, .nav-item');
  if (!btn || reduceMotion) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const rip = document.createElement('span');
  rip.className = 'ripple';
  rip.style.width = rip.style.height = `${size}px`;
  rip.style.left = `${e.clientX - r.left - size / 2}px`;
  rip.style.top = `${e.clientY - r.top - size / 2}px`;
  btn.appendChild(rip);
  setTimeout(() => rip.remove(), 650);
});

/* 快捷键：/ 聚焦搜索 · N 新建服务 · C 一键全签 */
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k !== '/' && k !== 'n' && k !== 'c') return;
  const tag = (document.activeElement || {}).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.querySelector('.modal-mask:not(.hidden)')) return;
  if (k === '/') { e.preventDefault(); $('#search').focus(); }
  else if (k === 'n' && live()) { e.preventDefault(); openModal(null); }
  else if (k === 'c' && live()) { e.preventDefault(); $('#btn-check-all').click(); }
});

/* 卡片拖拽排序（登录后可用，顺序自动保存到服务端） */
let dragId = null;
const gridEl = document.getElementById('grid');
gridEl.addEventListener('dragstart', (e) => {
  const c = e.target.closest('.card');
  if (!c || !live()) { e.preventDefault(); return; }
  dragId = c.dataset.id;
  c.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
gridEl.addEventListener('dragend', () => {
  dragId = null;
  gridEl.querySelectorAll('.dragging,.drag-over').forEach((x) => x.classList.remove('dragging', 'drag-over'));
});
gridEl.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const c = e.target.closest('.card');
  gridEl.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  if (c && c.dataset.id !== dragId) c.classList.add('drag-over');
});
gridEl.addEventListener('drop', async (e) => {
  if (!dragId) return;
  e.preventDefault();
  const c = e.target.closest('.card');
  const from = services.findIndex((s) => s.id === dragId);
  gridEl.querySelectorAll('.dragging,.drag-over').forEach((x) => x.classList.remove('dragging', 'drag-over'));
  if (from < 0 || !c || c.dataset.id === dragId) { dragId = null; return; }
  const to = services.findIndex((s) => s.id === c.dataset.id);
  if (to < 0) { dragId = null; return; }
  const [moved] = services.splice(from, 1);
  services.splice(to, 0, moved);
  services.forEach((s, i) => { s.sortOrder = i; });
  dragId = null;
  renderAll();
  try {
    await api('/api/reorder', { method: 'POST', body: JSON.stringify({ ids: services.map((s) => s.id) }) });
    toast('排序已保存');
  } catch (err) { handleAuthErr(err); }
});

/* 卡片聚光灯 + 3D 倾斜（事件委托，兼容动态渲染） */
document.addEventListener('mousemove', (e) => {
  const glow = e.target.closest('.card, .stat, .ach');
  if (glow) {
    const r = glow.getBoundingClientRect();
    glow.style.setProperty('--mx', `${e.clientX - r.left}px`);
    glow.style.setProperty('--my', `${e.clientY - r.top}px`);
  }
  if (reduceMotion) return;
  const card = e.target.closest('.card');
  document.querySelectorAll('.card.is-tilting').forEach((c) => {
    if (c !== card) { c.classList.remove('is-tilting'); c.style.transform = ''; }
  });
  if (card) {
    const r = card.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - .5) * -5;
    const ry = ((e.clientX - r.left) / r.width - .5) * 5;
    card.classList.add('is-tilting');
    card.style.transform = `translateY(-4px) perspective(750px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
  }
});

/* ---------- 启动：先渲染公开预览，已有会话则无缝进入正式模式 ---------- */
(async function init() {
  try { await loadPreview(); } catch {}
  try { await loadAll(); } catch {}
})();
