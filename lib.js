// RU-защита — общие функции для фонового скрипта, уведомления и popup.
const RU = (() => {
  const ZONES = ['ru', 'xn--p1ai']; // .ru и .рф (punycode)

  // Публичные суффиксы (подмножество Public Suffix List): основным доменом
  // считается домен на уровень ниже — city.msk.ru, bbc.co.uk, user.github.io.
  const SUFFIXES = new Set([
    'ac.ru', 'edu.ru', 'gov.ru', 'int.ru', 'mil.ru', 'test.ru',
    'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.ru', 'spb.ru',
    // хостинги, где у каждого клиента свой поддомен
    'github.io', 'gitlab.io', 'blogspot.com', 'appspot.com', 'herokuapp.com',
    'firebaseapp.com', 'web.app', 'netlify.app', 'vercel.app', 'pages.dev',
    'workers.dev', 'onrender.com', 'glitch.me', 'cloudfront.net',
    'azurewebsites.net', 's3.amazonaws.com',
  ]);
  // Второй уровень национальных зон: co.uk, com.au, co.jp, com.br …
  const CC_SECOND = new Set([
    'ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'gv', 'ltd', 'me',
    'mil', 'ne', 'net', 'nic', 'nom', 'or', 'org', 'plc', 'sch',
  ]);

  function isSuffix(s) {
    if (SUFFIXES.has(s)) return true;
    const p = s.split('.');
    return p.length === 2 && p[1].length === 2 && !ZONES.includes(p[1]) && CC_SECOND.has(p[0]);
  }

  const isIP = (host) => /^\d+(\.\d+){3}$/.test(host) || host.includes(':');

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

  // Основной (регистрируемый) домен: www.shop.ru → shop.ru, play.google.com → google.com.
  function siteOf(host) {
    if (!host || isIP(host)) return host;
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (isSuffix(parts.slice(i).join('.'))) return parts.slice(i - 1).join('.');
    }
    return parts.slice(-2).join('.');
  }

  // RFC 3492: метка punycode без префикса xn-- → Unicode.
  function punyDecode(input) {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    const out = [];
    let n = 128, i = 0, bias = 72;
    const b = input.lastIndexOf('-');
    for (let j = 0; j < Math.max(b, 0); j++) out.push(input.charCodeAt(j));
    for (let idx = b > 0 ? b + 1 : 0; idx < input.length; ) {
      const oldi = i;
      for (let w = 1, k = base; ; k += base) {
        if (idx >= input.length) throw new Error('bad punycode');
        const c = input.charCodeAt(idx++);
        const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 : base;
        if (digit >= base) throw new Error('bad punycode');
        i += digit * w;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        w *= base - t;
      }
      const len = out.length + 1;
      let delta = oldi === 0 ? Math.floor((i - oldi) / damp) : (i - oldi) >> 1;
      delta += Math.floor(delta / len);
      let k = 0;
      for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
      bias = k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
      n += Math.floor(i / len);
      i %= len;
      out.splice(i++, 0, n);
    }
    return String.fromCodePoint(...out);
  }

  // Для показа пользователю: xn--80aswg.xn--p1ai → сайт.рф. Домены других зон
  // остаются в punycode — иначе xn--80ak6aa92e.com выглядел бы как «apple.com».
  function display(host) {
    if (!host || !(host === 'xn--p1ai' || host.endsWith('.xn--p1ai'))) return host;
    return host
      .split('.')
      .map((label) => {
        if (!label.startsWith('xn--')) return label;
        try {
          return punyDecode(label.slice(4));
        } catch {
          return label;
        }
      })
      .join('.');
  }

  // Подпись под основным доменом: к каким его адресам обращалась страница.
  function hostsLine(item) {
    const hosts = item.hosts || [];
    if (hosts.every((h) => h === item.host)) return '';
    const shown = hosts.slice(0, 4).map(display).join(', ');
    return hosts.length > 4 ? `${shown} и ещё ${hosts.length - 4}` : shown;
  }

  return { ZONES, hostOf, inList, inZone, siteOf, display, hostsLine };
})();
