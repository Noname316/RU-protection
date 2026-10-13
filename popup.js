const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const STATUS = {
  pending: ['ожидает решения', 'wait'],
  auto: ['заблокирован автоматически', 'bad'],
  blocked: ['заблокирован', 'bad'],
  allowed: ['разрешён', 'ok'],
  passed: ['пропущен', 'muted'],
};

let tabId = null;
let currentList = 'allowed';

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

function domainCell(host, statusText, statusCls) {
  const wrap = document.createElement('div');
  wrap.className = 'grow';
  const d = document.createElement('span');
  d.className = 'dom';
  d.textContent = host;
  wrap.append(d);
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

function renderMode({ notify, autoBlock }) {
  $('notify').checked = notify;
  $('autoBlock').checked = autoBlock;
  $('mode').textContent = autoBlock
    ? 'Все обращения сайтов .ru/.рф к другим зонам блокируются, кроме разрешённых доменов.' +
      (notify ? ' О блокировке сообщается уведомлением.' : '')
    : notify
      ? 'Новый внешний домен блокируется до вашего решения — справа внизу появится запрос «Разрешить / Заблокировать».'
      : 'Защита пассивна: блокируются только домены из списка заблокированных.';
}

async function decide(host, decision) {
  const state = await send({ type: 'decide', hosts: [host], decision, tabId });
  renderPage(state);
  renderLists(await send({ type: 'getLists' }));
}

function renderPage(state) {
  renderMode(state.settings);
  const list = $('pageList');
  list.replaceChildren();
  $('pageTitle').textContent = state.page ? `Эта страница: ${state.page}` : 'Эта страница';
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
    const suffix = (it.reload ? ' · нужна перезагрузка' : '') + (it.count > 1 ? ` · ${it.count} запр.` : '');
    const blocking = it.status !== 'allowed' && it.status !== 'passed';
    list.append(li(
      domainCell(it.host, text + suffix, cls),
      blocking
        ? button('Разрешить', 'b allow', () => decide(it.host, 'allow'))
        : button('Заблокировать', 'b block', () => decide(it.host, 'block'))
    ));
  }
}

let lists = { allowed: [], blocked: [] };

function renderLists(next) {
  if (next) lists = next;
  $('allowedCount').textContent = lists.allowed.length ? `(${lists.allowed.length})` : '';
  $('blockedCount').textContent = lists.blocked.length ? `(${lists.blocked.length})` : '';
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.list === currentList);
    b.setAttribute('aria-selected', String(b.dataset.list === currentList));
  });
  const ul = $('lists');
  ul.replaceChildren();
  const items = [...lists[currentList]].sort();
  if (!items.length) {
    ul.append(empty('Список пуст.'));
    return;
  }
  for (const host of items) {
    const rm = button('×', 'rm', async () => {
      renderLists(await send({ type: 'unlist', list: currentList, host }));
      renderPage(await send({ type: 'getState', tabId }));
    });
    rm.title = 'Удалить из списка';
    ul.append(li(domainCell(host), rm));
  }
}

async function setSetting(key, value) {
  renderPage(await send({ type: 'setSettings', patch: { [key]: value }, tabId }));
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;

  $('notify').addEventListener('change', (e) => setSetting('notify', e.target.checked));
  $('autoBlock').addEventListener('change', (e) => setSetting('autoBlock', e.target.checked));
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      currentList = b.dataset.list;
      renderLists();
    })
  );

  const [state, l] = await Promise.all([send({ type: 'getState', tabId }), send({ type: 'getLists' })]);
  renderPage(state);
  renderLists(l);
}

main();
