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

const ZONES = ['ru', 'xn--p1ai']; // .ru и .рф (punycode)
const DEFAULTS = { notify: true, autoBlock: false, allowed: [], blocked: [] };
const BASE_CONDITION = { initiatorDomains: ZONES, excludedResourceTypes: ['main_frame'] };

let settings = { ...DEFAULTS };
// tabs[tabId] = { page: 'site.ru', items: { host: { host, status, count, reload } } }
// status: 'pending' | 'auto' | 'blocked' | 'allowed' | 'passed'
let tabs = {};
const ready = init();

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  try {
    tabs = (await chrome.storage.session.get({ tabs: {} })).tabs || {};
  } catch {
    tabs = {};
  }
  await syncRules();
}

// ---------- Утилиты ----------

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/\.$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function inList(host, list) {
  return list.some((d) => host === d || host.endsWith('.' + d));
}

const inZone = (host) => inList(host, ZONES);

function statusFor(host) {
  if (inList(host, settings.allowed)) return 'allowed';
  if (inList(host, settings.blocked)) return 'blocked';
  if (settings.autoBlock) return 'auto';
  if (settings.notify) return 'pending';
  return 'passed';
}

const isBlocking = (status) => status === 'pending' || status === 'auto' || status === 'blocked';

// ---------- Правила DNR ----------

let rulesQueue = Promise.resolve();

function syncRules() {
  rulesQueue = rulesQueue.then(applyRules, applyRules);
  return rulesQueue;
}

async function applyRules() {
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
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: rules,
  });
}

// ---------- Состояние вкладок ----------

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ tabs }).catch(() => {}), 300);
}

function view(tabId) {
  const t = tabs[tabId];
  return {
    settings: { notify: settings.notify, autoBlock: settings.autoBlock },
    page: t ? t.page : null,
    items: t ? Object.values(t.items) : [],
  };
}

function updateBadge(tabId) {
  const items = Object.values(tabs[tabId]?.items || {});
  const blocked = items.filter((i) => isBlocking(i.status));
  const hasPending = blocked.some((i) => i.status === 'pending');
  const id = Number(tabId);
  chrome.action.setBadgeText({ tabId: id, text: blocked.length ? String(blocked.length) : '' }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({ tabId: id, color: hasPending ? '#d97706' : '#dc2626' })
    .catch(() => {});
}

const pushTimers = {};
function pushTab(tabId) {
  clearTimeout(pushTimers[tabId]);
  pushTimers[tabId] = setTimeout(() => {
    delete pushTimers[tabId];
    updateBadge(tabId);
    chrome.tabs.sendMessage(Number(tabId), { type: 'state', ...view(tabId) }).catch(() => {});
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
      const next = statusFor(it.host);
      if (next === it.status) continue;
      // Уже заблокированный ресурс появится только после перезагрузки страницы.
      if (isBlocking(it.status) && !isBlocking(next)) it.reload = true;
      if (isBlocking(next)) it.reload = false;
      it.status = next;
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

  const it = t.items[to];
  if (it) {
    it.count++;
  } else {
    const status = statusFor(to);
    // Разрешённые заранее домены — обычный трафик, его не показываем.
    if (status === 'allowed') return;
    t.items[to] = { host: to, status, count: 1, reload: false };
  }
  pushTab(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === 'main_frame') {
      if (d.tabId >= 0) ready.then(() => resetTab(d.tabId, d.url));
      return;
    }
    onRequest(d);
  },
  { urls: ['<all_urls>'] }
);

// Запросы, заблокированные правилами DNR, гарантированно видны здесь.
chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (d.error && d.error.includes('BLOCKED_BY_CLIENT')) onRequest(d);
  },
  { urls: ['<all_urls>'] }
);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  delete tabs[tabId];
  saveSoon();
});

// ---------- Действия пользователя ----------

async function saveLists() {
  await chrome.storage.local.set({ allowed: settings.allowed, blocked: settings.blocked });
  await syncRules();
  refreshStatuses();
}

async function decide(hosts, decision) {
  const add = decision === 'allow' ? 'allowed' : 'blocked';
  const other = add === 'allowed' ? 'blocked' : 'allowed';
  const set = new Set(hosts.map((h) => String(h).toLowerCase()).filter(Boolean));
  settings[other] = settings[other].filter((d) => !set.has(d));
  for (const h of set) if (!settings[add].includes(h)) settings[add].push(h);
  await saveLists();
}

async function unlist(list, host) {
  if (list !== 'allowed' && list !== 'blocked') return;
  settings[list] = settings[list].filter((d) => d !== host);
  await saveLists();
}

async function setSettings(patch) {
  for (const key of ['notify', 'autoBlock']) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  }
  await chrome.storage.local.set({ notify: settings.notify, autoBlock: settings.autoBlock });
  await syncRules();
  refreshStatuses();
  for (const tabId of Object.keys(tabs)) pushTab(tabId);
}

async function handle(msg, sender) {
  await ready;
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    case 'getState':
      return view(tabId);
    case 'decide':
      await decide(msg.hosts, msg.decision);
      return view(tabId);
    case 'unlist':
      await unlist(msg.list, msg.host);
      return { allowed: settings.allowed, blocked: settings.blocked };
    case 'getLists':
      return { allowed: settings.allowed, blocked: settings.blocked };
    case 'setSettings':
      await setSettings(msg.patch || {});
      return view(tabId);
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
