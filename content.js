// RU-защита — уведомление в правом нижнем углу страницы .ru/.рф.
(() => {
  if (window.top !== window) return;

  const ext = globalThis.browser ?? globalThis.chrome;

  const AUTO_HIDE_MS = 8000;

  let state = { settings: { notify: true, autoBlock: false, scope: 'site' }, page: null, site: null, items: [] };
  const decidedHere = new Set(); // домены, по которым решение принято на этой странице
  let dismissedHosts = null; // при закрытии запоминаем, что уже видели
  let hovered = false;
  let hideTimer = null;
  let host = null;
  let root = null;

  const STYLE = `
    :host { all: initial; }
    .box {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: 360px; max-width: calc(100vw - 32px);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      color: #1f2328; background: #fff; border: 1px solid #d0d7de; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); overflow: hidden;
      animation: in .18s ease-out;
    }
    @keyframes in { from { transform: translateY(12px); opacity: 0 } to { transform: none; opacity: 1 } }
    .head { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
    .title { font-weight: 600; font-size: 13.5px; }
    .sub { color: #59636e; font-size: 12px; }
    .grow { flex: 1; min-width: 0; }
    .x { border: 0; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #59636e; padding: 0 2px; }
    .x:hover { color: #1f2328; }
    .list { max-height: 260px; overflow-y: auto; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 12px; border-bottom: 1px solid #eef1f4; }
    .row > .grow { flex: 1 1 100%; }
    .row:last-child { border-bottom: 0; }
    .dom { font: 600 12.5px/1.3 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
    .subs { font: 11px/1.3 ui-monospace, Consolas, monospace; color: #59636e; overflow-wrap: anywhere; }
    .meta { font-size: 11.5px; color: #59636e; }
    .meta.bad { color: #cf222e; } .meta.ok { color: #1a7f37; } .meta.wait { color: #9a6700; }
    .btns { display: flex; gap: 6px; flex-shrink: 0; }
    button.b { font: 600 12px system-ui, sans-serif; border-radius: 6px; padding: 5px 9px; cursor: pointer; border: 1px solid transparent; }
    .allow { background: #1f883d; color: #fff; } .allow:hover { background: #1a7f37; }
    .block { background: #cf222e; color: #fff; } .block:hover { background: #a40e26; }
    .ghost { background: #fff; color: #1f2328; border-color: #d0d7de !important; } .ghost:hover { background: #f3f4f6; }
    .scope { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 8px 12px; border-bottom: 1px solid #d0d7de; font-size: 12px; color: #59636e; }
    .seg { display: inline-flex; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
    .seg button { font: 600 12px system-ui, sans-serif; border: 0; padding: 4px 9px; cursor: pointer; background: #fff; color: #59636e; }
    .seg button + button { border-left: 1px solid #d0d7de; }
    .seg button.on { background: #0969da; color: #fff; }
    .foot { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px; background: #f6f8fa; border-top: 1px solid #d0d7de; }
    .line { display: flex; align-items: center; gap: 6px; }
    .foot .grow { font-size: 12px; color: #59636e; }
    @media (prefers-color-scheme: dark) {
      .box { color: #e6edf3; background: #161b22; border-color: #30363d; }
      .head, .foot { background: #0d1117; border-color: #30363d; }
      .row { border-color: #21262d; }
      .scope, .seg, .seg button + button { border-color: #30363d; }
      .scope { color: #9198a1; }
      .seg button { background: #21262d; color: #9198a1; }
      .seg button.on { background: #1f6feb; color: #fff; }
      .sub, .subs, .meta, .x, .foot .grow { color: #9198a1; }
      .x:hover { color: #e6edf3; }
      .meta.bad { color: #ff7b72; } .meta.ok { color: #3fb950; } .meta.wait { color: #d29922; }
      .ghost { background: #21262d; color: #e6edf3; border-color: #30363d !important; } .ghost:hover { background: #30363d; }
    }
  `;

  function send(msg) {
    return ext.runtime.sendMessage(msg).catch(() => null);
  }

  function ensureRoot() {
    if (root) return;
    host = document.createElement('ru-protection-toast');
    root = host.attachShadow({ mode: 'closed' });
    (document.body || document.documentElement).appendChild(host);
  }

  function visibleItems() {
    return state.items.filter(
      (i) => i.status === 'pending' || i.status === 'auto' || i.reload || decidedHere.has(i.host)
    );
  }

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick') n.addEventListener('click', v);
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  }

  async function decide(hosts, decision) {
    hosts.forEach((h) => decidedHere.add(h));
    const res = await send({ type: 'decide', hosts, decision, scope: state.settings.scope });
    if (res && res.items) apply(res);
  }

  async function setScope(scope) {
    const res = await send({ type: 'setSettings', patch: { scope } });
    if (res && res.items) apply(res);
  }

  const where = (it) => (it.scope === 'site' ? ' на этом сайте' : it.scope === 'global' ? ' везде' : '');

  function scopeBar() {
    const scope = state.settings.scope;
    const site = RU.display(state.site || location.hostname);
    const opt = (value, text) =>
      el('button', { class: scope === value ? 'on' : '', 'aria-pressed': String(scope === value), onclick: () => setScope(value) }, text);
    return el('div', { class: 'scope' }, 'Решение действует:',
      el('div', { class: 'seg' }, opt('site', `на ${site}`), opt('global', 'на всех сайтах')));
  }

  function rowFor(it) {
    let meta, btns;
    const times = it.count > 1 ? ` · ${it.count} запр.` : '';
    if (it.status === 'pending') {
      meta = el('div', { class: 'meta wait' }, 'ожидает решения' + times);
      btns = el('div', { class: 'btns' },
        el('button', { class: 'b allow', onclick: () => decide([it.host], 'allow') }, 'Разрешить'),
        el('button', { class: 'b block', onclick: () => decide([it.host], 'block') }, 'Заблокировать'));
    } else if (it.status === 'auto') {
      meta = el('div', { class: 'meta bad' }, 'заблокирован автоматически' + times);
      btns = el('div', { class: 'btns' },
        el('button', { class: 'b ghost', onclick: () => decide([it.host], 'allow') }, 'Разрешить'));
    } else if (it.status === 'blocked') {
      meta = el('div', { class: 'meta bad' }, 'заблокирован' + where(it) + times);
      btns = el('div', { class: 'btns' },
        el('button', { class: 'b ghost', onclick: () => decide([it.host], 'allow') }, 'Разрешить'));
    } else {
      meta = el('div', { class: 'meta ok' }, 'разрешён' + where(it) + (it.reload ? ' · нужна перезагрузка' : '') + times);
      btns = el('div', { class: 'btns' },
        el('button', { class: 'b ghost', onclick: () => decide([it.host], 'block') }, 'Заблокировать'));
    }
    const subs = RU.hostsLine(it);
    return el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { class: 'dom' }, RU.display(it.host)),
        subs ? el('div', { class: 'subs' }, subs) : null,
        meta),
      btns);
  }

  function title(items, pending) {
    if (pending.length) return 'Обращение к другой доменной зоне';
    if (items.some((i) => i.status === 'auto' || i.status === 'blocked')) return 'Внешние обращения заблокированы';
    return 'Обращения к другим зонам';
  }

  function hide() {
    clearTimeout(hideTimer);
    if (host) host.remove();
    host = root = null;
  }

  function render() {
    if (!state.settings.notify) return hide();
    let items = visibleItems();
    if (dismissedHosts) {
      // После закрытия показываем снова только при появлении новых доменов.
      const fresh = items.some(
        (i) => (i.status === 'pending' || i.status === 'auto') && !dismissedHosts.has(i.host)
      );
      if (!fresh) return hide();
      dismissedHosts = null;
    }
    if (!items.length) return hide();

    const pending = items.filter((i) => i.status === 'pending');
    const needReload = items.some((i) => i.reload);
    items = [...pending, ...items.filter((i) => i.status !== 'pending')];

    ensureRoot();
    const page = RU.display(state.page || location.hostname);
    const box = el('div', { class: 'box', role: 'dialog', 'aria-label': 'RU-защита' },
      el('div', { class: 'head' },
        el('div', { class: 'grow' },
          el('div', { class: 'title' }, title(items, pending)),
          el('div', { class: 'sub' }, `${page} обращается к доменам вне .ru/.рф`)),
        el('button', {
          class: 'x', title: 'Закрыть', 'aria-label': 'Закрыть',
          onclick: () => { dismissedHosts = new Set(state.items.map((i) => i.host)); hide(); },
        }, '×')),
      scopeBar(),
      el('div', { class: 'list' }, ...items.map(rowFor)));

    const foot = el('div', { class: 'foot' });
    if (pending.length > 1) {
      const hosts = pending.map((i) => i.host);
      foot.append(el('div', { class: 'line' },
        el('button', { class: 'b allow', onclick: () => decide(hosts, 'allow') }, 'Разрешить все'),
        el('button', { class: 'b block', onclick: () => decide(hosts, 'block') }, 'Заблокировать все')));
    }
    if (needReload) {
      foot.append(el('div', { class: 'line' },
        el('div', { class: 'grow' }, 'Разрешённое заработает после перезагрузки страницы'),
        el('button', { class: 'b ghost', onclick: () => location.reload() }, 'Перезагрузить')));
    }
    if (foot.childNodes.length) box.append(foot);

    box.addEventListener('mouseenter', () => { hovered = true; clearTimeout(hideTimer); });
    box.addEventListener('mouseleave', () => { hovered = false; scheduleHide(); });

    root.replaceChildren(el('style', {}, STYLE), box);
    if (!box.matches(':hover')) hovered = false;
    scheduleHide();
  }

  // Информационное уведомление (без вопросов) прячется само.
  function scheduleHide() {
    clearTimeout(hideTimer);
    const items = visibleItems();
    if (hovered || items.some((i) => i.status === 'pending' || i.reload)) return;
    hideTimer = setTimeout(() => {
      dismissedHosts = new Set(state.items.map((i) => i.host));
      hide();
    }, AUTO_HIDE_MS);
  }

  function apply(next) {
    state = next;
    if (document.readyState === 'loading' && !document.body) {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    } else {
      render();
    }
  }

  ext.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'state') apply(msg);
  });

  send({ type: 'getState' }).then((res) => res && res.items && apply(res));
})();
