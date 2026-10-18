const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (msg) => ext.runtime.sendMessage(msg);

const STATUS = {
  pending: ['ожидает решения', 'wait'],
  auto: ['заблокирован автоматически', 'bad'],
  blocked: ['заблокирован', 'bad'],
  allowed: ['разрешён', 'ok'],
  passed: ['пропущен', 'muted'],
};
const WHERE = { site: ' на этом сайте', global: ' везде' };

let tabId = null;
let pageSite = null;
let currentView = 'sites';
let lists = { allowed: [], blocked: [], sites: {} };

function li(...children) {
  const n = document.createElement('li');
  n.append(...children);
  return n;
}

function button(text, cls, onclick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onclick);
  return b;
}

function domainCell(host, statusText, statusCls, subsText) {
  const wrap = document.createElement('div');
  wrap.className = 'grow';
  const d = document.createElement('span');
  d.className = 'dom';
  d.textContent = RU.display(host);
  wrap.append(d);
  if (subsText) {
    const s = document.createElement('span');
    s.className = 'subs';
    s.textContent = subsText;
    wrap.append(s);
  }
  if (statusText) {
    const s = document.createElement('span');
    s.className = 'st ' + statusCls;
    s.textContent = statusText;
    wrap.append(s);
  }
  return wrap;
}

function empty(text) {
  const n = li(text);
  n.className = 'empty';
  return n;
}

function renderMode({ notify, autoBlock, scope }) {
  $('notify').checked = notify;
  $('autoBlock').checked = autoBlock;
  $('mode').textContent = autoBlock
    ? 'Все обращения сайтов .ru/.рф к другим зонам блокируются, кроме разрешённых доменов.' +
      (notify ? ' О блокировке сообщается уведомлением.' : '')
    : notify
      ? 'Новый внешний домен блокируется до вашего решения — справа внизу появится запрос «Разрешить / Заблокировать».'
      : 'Защита пассивна: блокируются только домены из списков заблокированных.';
  document.querySelectorAll('#scope button').forEach((b) => {
    b.classList.toggle('on', b.dataset.scope === scope);
    b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
  });
}

async function refresh(state) {
  renderPage(state || (await send({ type: 'getState', tabId })));
  renderLists(await send({ type: 'getLists' }));
}

async function decide(host, decision) {
  await refresh(await send({ type: 'decide', hosts: [host], decision, tabId }));
}

function renderPage(state) {
  renderMode(state.settings);
  pageSite = state.site;
  $('scope').hidden = !pageSite;
  if (pageSite) $('scopeSite').textContent = `на ${RU.display(pageSite)}`;
  const list = $('pageList');
  list.replaceChildren();
  $('pageTitle').textContent = state.page ? `Эта страница: ${RU.display(state.page)}` : 'Эта страница';
  if (!state.page && !state.items.length) {
    list.append(empty('Защита работает только на сайтах .ru и .рф.'));
    return;
  }
  if (!state.items.length) {
    list.append(empty('Обращений к другим зонам не было.'));
    return;
  }
  const order = { pending: 0, auto: 1, blocked: 2, allowed: 3, passed: 4 };
  for (const it of [...state.items].sort((a, b) => order[a.status] - order[b.status])) {
    const [text, cls] = STATUS[it.status] || ['', 'muted'];
    const suffix =
      (WHERE[it.scope] || '') + (it.reload ? ' · нужна перезагрузка' : '') + (it.count > 1 ? ` · ${it.count} запр.` : '');
    const blocking = it.status !== 'allowed' && it.status !== 'passed';
    list.append(li(
      domainCell(it.host, text + suffix, cls, RU.hostsLine(it)),
      blocking
        ? button('Разрешить', 'b allow', () => decide(it.host, 'allow'))
        : button('Заблокировать', 'b block', () => decide(it.host, 'block'))
    ));
  }
}

// Строки списка: сначала разрешённые, затем заблокированные, каждая с кнопкой удаления.
function entryRows(own, site) {
  const rows = [];
  for (const [key, text, cls] of [['allowed', 'разрешён', 'ok'], ['blocked', 'заблокирован', 'bad']]) {
    for (const host of [...own[key]].sort()) {
      const rm = button('×', 'rm', async () => {
        renderLists(await send({ type: 'unlist', list: key, host, site }));
        renderPage(await send({ type: 'getState', tabId }));
      });
      rm.title = 'Удалить из списка';
      rows.push(li(domainCell(host, text, cls), rm));
    }
  }
  return rows;
}

function siteHeader(site) {
  const name = document.createElement('span');
  name.className = 'grow';
  name.textContent = RU.display(site);
  if (site === pageSite) {
    const here = document.createElement('span');
    here.className = 'here';
    here.textContent = ' · эта страница';
    name.append(here);
  }
  const reset = button('сбросить', 'link', async () => {
    renderLists(await send({ type: 'forgetSite', site }));
    renderPage(await send({ type: 'getState', tabId }));
  });
  reset.title = 'Удалить все решения для этого сайта';
  const row = li(name, reset);
  row.className = 'site';
  return row;
}

function renderLists(next) {
  if (next) lists = next;
  const sites = Object.keys(lists.sites).sort((a, b) => (a === pageSite ? -1 : b === pageSite ? 1 : a.localeCompare(b)));
  const globalCount = lists.allowed.length + lists.blocked.length;
  $('sitesCount').textContent = sites.length ? `(${sites.length})` : '';
  $('globalCount').textContent = globalCount ? `(${globalCount})` : '';
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === currentView);
    b.setAttribute('aria-selected', String(b.dataset.view === currentView));
  });

  const ul = $('lists');
  ul.replaceChildren();
  if (currentView === 'global') {
    const rows = entryRows(lists, null);
    ul.append(...(rows.length ? rows : [empty('Общих решений пока нет.')]));
    return;
  }
  if (!sites.length) {
    ul.append(empty('Решений для отдельных сайтов пока нет.'));
    return;
  }
  for (const site of sites) ul.append(siteHeader(site), ...entryRows(lists.sites[site], site));
}

async function setSetting(key, value) {
  renderPage(await send({ type: 'setSettings', patch: { [key]: value }, tabId }));
}

// В Firefox пользователь может отозвать доступ к сайтам; без него webRequest
// и уведомления не работают (блокировка DNR при этом продолжает действовать).
async function checkAccess() {
  const origins = { origins: ['<all_urls>'] };
  const ok = await ext.permissions.contains(origins);
  $('access').hidden = ok;
  $('grant').onclick = async () => {
    if (await ext.permissions.request(origins)) $('access').hidden = true;
  };
}

async function main() {
  checkAccess();
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;

  $('notify').addEventListener('change', (e) => setSetting('notify', e.target.checked));
  $('autoBlock').addEventListener('change', (e) => setSetting('autoBlock', e.target.checked));
  document.querySelectorAll('#scope button').forEach((b) =>
    b.addEventListener('click', () => setSetting('scope', b.dataset.scope))
  );
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      currentView = b.dataset.view;
      renderLists();
    })
  );

  const state = await send({ type: 'getState', tabId });
  if (!state.site) currentView = 'global';
  await refresh(state);
}

main();
