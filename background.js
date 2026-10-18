// RU-защита — фоновый service worker.
//
// Блокировка выполняется правилами declarativeNetRequest (в MV3 нельзя
// «придержать» запрос до ответа пользователя), а обнаружение внешних
// обращений — через webRequest в режиме наблюдения.
//
// Режимы:
//   autoBlock = on            — всё, что идёт с .ru/.рф в другие зоны, блокируется,
//                               кроме белого списка (notify = уведомлять об этом).
//   autoBlock = off, notify = on  — новый внешний домен блокируется до решения
//                               пользователя, справа внизу появляется запрос.
//   autoBlock = off, notify = off — блокируется только чёрный список.
//
// Списки: общие (для всех сайтов) и отдельные для каждого сайта. Решение для
// сайта важнее общего. В списках хранятся только основные домены: решение
// для google.com действует и на play.google.com, и на api.google.com.
// Приоритеты правил DNR (больше — важнее):
//   1 — общая блокировка / общий чёрный список
//   2 — общий белый список
//   3 — чёрный список сайта
//   4 — белый список сайта

// Firefox даёт API как `browser`, Chromium — как `chrome`; оба возвращают промисы.
const ext = globalThis.browser ?? globalThis.chrome;
// В Firefox lib.js подключён в манифесте перед этим файлом, в Chromium — здесь.
if (typeof RU === 'undefined') importScripts('lib.js');

const { ZONES, hostOf, inList, inZone, siteOf } = RU;
const DEFAULTS = { notify: true, autoBlock: false, scope: 'site', allowed: [], blocked: [], sites: {} };
const BASE_CONDITION = { initiatorDomains: ZONES, excludedResourceTypes: ['main_frame'] };
const SITE_RULES_FROM = 100;

let settings = { ...DEFAULTS };
// tabs[tabId] = { page: 'www.shop.ru', items: { domain: { host: domain, hosts, site, status, scope, count, reload } } }
// host — основной домен (google.com), hosts — встреченные адреса (play.google.com, …)
// status: 'pending' | 'auto' | 'blocked' | 'allowed' | 'passed'
// scope:  'site' | 'global' | null — откуда взялось решение
let tabs = {};
const ready = init();

async function init() {
  settings = structuredClone({ ...DEFAULTS, ...(await ext.storage.local.get(DEFAULTS)) });
  try {
    tabs = (await ext.storage.session.get({ tabs: {} })).tabs || {};
  } catch {
    tabs = {};
  }
  if (normalizeLists()) {
    await ext.storage.local.set({ allowed: settings.allowed, blocked: settings.blocked, sites: settings.sites });
  }
  await syncRules();
}

// Прежние версии записывали каждый поддомен отдельно — сводим их к основным
// доменам. Если домен оказался и среди разрешённых, и среди заблокированных,
// остаётся блокировка. Возвращает true, если списки изменились.
function normalizeLists() {
  const snapshot = () => JSON.stringify([settings.allowed, settings.blocked, settings.sites]);
  const before = snapshot();
  for (const lists of [settings, ...Object.values(settings.sites)]) {
    lists.blocked = [...new Set(lists.blocked.map(siteOf))];
    lists.allowed = [...new Set(lists.allowed.map(siteOf))].filter((d) => !lists.blocked.includes(d));
  }
  return snapshot() !== before;
}

// ---------- Решение по домену ----------

function verdict(host, site) {
  const own = settings.sites[site];
  if (own) {
    if (inList(host, own.allowed)) return { status: 'allowed', scope: 'site' };
    if (inList(host, own.blocked)) return { status: 'blocked', scope: 'site' };
  }
  if (inList(host, settings.allowed)) return { status: 'allowed', scope: 'global' };
  if (inList(host, settings.blocked)) return { status: 'blocked', scope: 'global' };
  if (settings.autoBlock) return { status: 'auto', scope: null };
  if (settings.notify) return { status: 'pending', scope: null };
  return { status: 'passed', scope: null };
}

const isBlocking = (status) => status === 'pending' || status === 'auto' || status === 'blocked';

// ---------- Правила DNR ----------

let rulesQueue = Promise.resolve();

function syncRules() {
  rulesQueue = rulesQueue.then(applyRules, applyRules);
  return rulesQueue;
}

function buildRules() {
  const rules = [];
  if (settings.autoBlock || settings.notify) {
    rules.push({
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: { ...BASE_CONDITION, excludedRequestDomains: ZONES },
    });
  } else if (settings.blocked.length) {
    rules.push({
      id: 2,
      priority: 1,
      action: { type: 'block' },
      condition: { ...BASE_CONDITION, requestDomains: settings.blocked },
    });
  }
  if (settings.allowed.length) {
    rules.push({
      id: 3,
      priority: 2,
      action: { type: 'allow' },
      condition: { ...BASE_CONDITION, requestDomains: settings.allowed },
    });
  }
  let id = SITE_RULES_FROM;
  for (const [site, own] of Object.entries(settings.sites)) {
    const condition = { initiatorDomains: [site], excludedResourceTypes: ['main_frame'] };
    if (own.blocked.length) {
      rules.push({ id: id++, priority: 3, action: { type: 'block' }, condition: { ...condition, requestDomains: own.blocked } });
    }
    if (own.allowed.length) {
      rules.push({ id: id++, priority: 4, action: { type: 'allow' }, condition: { ...condition, requestDomains: own.allowed } });
    }
  }
  return rules;
}

async function applyRules() {
  const old = await ext.declarativeNetRequest.getDynamicRules();
  await ext.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: buildRules(),
  });
}

// ---------- Состояние вкладок ----------

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ext.storage.session.set({ tabs }).catch(() => {}), 300);
}

function view(tabId) {
  const t = tabs[tabId];
  const page = t ? t.page : null;
  return {
    settings: { notify: settings.notify, autoBlock: settings.autoBlock, scope: settings.scope },
    page,
    site: page ? siteOf(page) : null,
    items: t ? Object.values(t.items) : [],
  };
}

function updateBadge(tabId) {
  const items = Object.values(tabs[tabId]?.items || {});
  const blocked = items.filter((i) => isBlocking(i.status));
  const hasPending = blocked.some((i) => i.status === 'pending');
  const id = Number(tabId);
  ext.action.setBadgeText({ tabId: id, text: blocked.length ? String(blocked.length) : '' }).catch(() => {});
  ext.action
    .setBadgeBackgroundColor({ tabId: id, color: hasPending ? '#d97706' : '#dc2626' })
    .catch(() => {});
}

const pushTimers = {};
function pushTab(tabId) {
  clearTimeout(pushTimers[tabId]);
  pushTimers[tabId] = setTimeout(() => {
    delete pushTimers[tabId];
    updateBadge(tabId);
    ext.tabs.sendMessage(Number(tabId), { type: 'state', ...view(tabId) }).catch(() => {});
  }, 120);
  saveSoon();
}

function resetTab(tabId, url) {
  const page = hostOf(url);
  tabs[tabId] = { page: inZone(page) ? page : null, items: {} };
  pushTab(tabId);
}

// Пересчитать статусы во всех вкладках после смены настроек или списков.
function refreshStatuses() {
  for (const [tabId, t] of Object.entries(tabs)) {
    let changed = false;
    for (const it of Object.values(t.items)) {
      const next = verdict(it.host, it.site);
      if (next.status === it.status && next.scope === it.scope) continue;
      // Уже заблокированный ресурс появится только после перезагрузки страницы.
      if (isBlocking(it.status) && !isBlocking(next.status)) it.reload = true;
      if (isBlocking(next.status)) it.reload = false;
      it.status = next.status;
      it.scope = next.scope;
      changed = true;
    }
    if (changed) pushTab(tabId);
  }
}

// ---------- Наблюдение за запросами ----------

const seen = new Set();

async function onRequest(details) {
  if (details.tabId < 0 || details.type === 'main_frame') return;
  if (seen.has(details.requestId)) return;

  const from = hostOf(details.initiator || details.documentUrl || details.originUrl || '');
  const to = hostOf(details.url);
  if (!from || !to || !inZone(from) || inZone(to)) return;

  seen.add(details.requestId);
  if (seen.size > 5000) seen.clear();

  await ready;
  const tabId = details.tabId;
  const t = (tabs[tabId] ||= { page: null, items: {} });
  if (!t.page) t.page = from;

  // Поддомены одного основного домена показываются и решаются вместе.
  const domain = siteOf(to);
  const it = t.items[domain];
  if (it) {
    it.count++;
    const hosts = (it.hosts ||= []);
    if (!hosts.includes(to) && hosts.length < 20) hosts.push(to);
  } else {
    // Сайт берём по инициатору запроса — так же, как его видят правила DNR.
    const site = siteOf(from);
    const v = verdict(domain, site);
    // Разрешённые заранее домены — обычный трафик, его не показываем.
    if (v.status === 'allowed') return;
    t.items[domain] = { host: domain, hosts: [to], site, ...v, count: 1, reload: false };
  }
  pushTab(tabId);
}

ext.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === 'main_frame') {
      if (d.tabId >= 0) ready.then(() => resetTab(d.tabId, d.url));
      return;
    }
    onRequest(d);
  },
  { urls: ['<all_urls>'] }
);

// Запросы, заблокированные правилами DNR, гарантированно видны здесь
// (Chromium: net::ERR_BLOCKED_BY_CLIENT, Firefox: NS_ERROR_*). Повторы
// отсекаются по requestId в onRequest.
ext.webRequest.onErrorOccurred.addListener(onRequest, { urls: ['<all_urls>'] });

ext.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  delete tabs[tabId];
  saveSoon();
});

// ---------- Действия пользователя ----------

const LIST_KEYS = ['allowed', 'blocked'];

function siteLists(site, create) {
  if (!settings.sites[site] && create) settings.sites[site] = { allowed: [], blocked: [] };
  return settings.sites[site];
}

function without(list, hosts) {
  return list.filter((d) => !hosts.has(d));
}

async function saveLists() {
  for (const [site, own] of Object.entries(settings.sites)) {
    if (!own.allowed.length && !own.blocked.length) delete settings.sites[site];
  }
  await ext.storage.local.set({ allowed: settings.allowed, blocked: settings.blocked, sites: settings.sites });
  await syncRules();
  refreshStatuses();
}

// entries: [{ host, site }]; scope: 'site' — только для сайта, 'global' — для всех.
async function decide(entries, decision, scope) {
  const add = decision === 'allow' ? 'allowed' : 'blocked';
  const other = add === 'allowed' ? 'blocked' : 'allowed';
  for (const { host, site } of entries) {
    const one = new Set([host]);
    if (scope === 'site' && site) {
      const own = siteLists(site, true);
      own[other] = without(own[other], one);
      if (!own[add].includes(host)) own[add].push(host);
    } else {
      settings[other] = without(settings[other], one);
      if (!settings[add].includes(host)) settings[add].push(host);
      // Решение «для всех» отменяет прежнее решение для этого сайта.
      const own = site && siteLists(site, false);
      if (own) for (const key of LIST_KEYS) own[key] = without(own[key], one);
    }
  }
  await saveLists();
}

async function unlist(list, host, site) {
  if (!LIST_KEYS.includes(list)) return;
  const target = site ? siteLists(site, false) : settings;
  if (target) target[list] = target[list].filter((d) => d !== host);
  await saveLists();
}

async function forgetSite(site) {
  delete settings.sites[site];
  await saveLists();
}

async function setSettings(patch) {
  for (const key of ['notify', 'autoBlock']) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  }
  if (patch.scope === 'site' || patch.scope === 'global') settings.scope = patch.scope;
  await ext.storage.local.set({ notify: settings.notify, autoBlock: settings.autoBlock, scope: settings.scope });
  await syncRules();
  refreshStatuses();
  for (const tabId of Object.keys(tabs)) pushTab(tabId);
}

function getLists() {
  return { allowed: settings.allowed, blocked: settings.blocked, sites: settings.sites };
}

async function handle(msg, sender) {
  await ready;
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    case 'getState':
      return view(tabId);
    case 'decide': {
      const t = tabs[tabId];
      const fallback = msg.site || (t && t.page ? siteOf(t.page) : null);
      const entries = (msg.hosts || []).map((h) => {
        const host = siteOf(String(h).toLowerCase());
        return { host, site: t?.items[host]?.site || fallback };
      });
      await decide(entries, msg.decision, msg.scope || settings.scope);
      return view(tabId);
    }
    case 'unlist':
      await unlist(msg.list, msg.host, msg.site);
      return getLists();
    case 'forgetSite':
      await forgetSite(msg.site);
      return getLists();
    case 'getLists':
      return getLists();
    case 'setSettings':
      await setSettings(msg.patch || {});
      return view(tabId);
  }
  return null;
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
