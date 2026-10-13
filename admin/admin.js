// Админка сайта ZosyaHandmadePictures.
// На компьютере разработчика (localhost) сохраняет в папку проекта через serve.mjs.
// На сайте сохраняет прямо в репозиторий GitHub; после сохранения сайт пересобирается сам.
(function () {
  'use strict';

  var CFG = window.ZOSYA || {};
  var LOCAL = ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0;
  var TOKEN_KEY = 'zosya-admin-token';
  var MAX_PHOTOS = 6;
  var MAX_SIDE = 2400;
  var SITE_HOST = (CFG.siteUrl || '').replace(/^https?:\/\//, '');
  var SITE_LINK = LOCAL ? '/' : (CFG.siteUrl || '') + '/';
  // Страница работы на сайте: у каждой своя русская и английская версия
  var artUrl = function (lang, slug) { return SITE_LINK + lang + '/art/' + slug + '/'; };
  var publicArtUrl = function (lang, slug) { return (CFG.siteUrl || location.origin) + '/' + lang + '/art/' + slug + '/'; };

  var S = {
    view: 'loading', artworks: [], settings: {}, baseSha: null,
    pending: { uploads: new Map(), deletes: new Set() }, // изменения списка, ещё не опубликованные
    previews: new Map(), // путь фото → временная ссылка на только что добавленный файл
    dirty: false, draft: null, busy: false
  };

  // ---------- Помощники ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (function add(kids) {
      kids.forEach(function (kid) {
        if (kid == null || kid === false) return;
        if (Array.isArray(kid)) add(kid);
        else el.append(kid.nodeType ? kid : String(kid));
      });
    })([].slice.call(arguments, 2));
    return el;
  }
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var nb = function (s) { return s.replace(/[\s  ,]/g, ' '); };
  var rub = function (n) { return nb(Math.round(n || 0).toLocaleString('ru-RU')) + ' ₽'; };
  var usd = function (n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); };
  var roundUsd = function (x) { return x < 100 ? Math.max(5, Math.round(x / 5) * 5) : Math.round(x / 10) * 10; };
  var autoUsd = function (price) { return S.settings.usdRate > 0 && price > 0 ? roundUsd(price / S.settings.usdRate) : 0; };
  var usdOf = function (a) { return a.priceUsd > 0 ? a.priceUsd : autoUsd(a.price); };

  var TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  function slugify(s) {
    return String(s || '').toLowerCase().split('').map(function (c) { return TR[c] != null ? TR[c] : c; }).join('')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  }
  function uniqueSlug(base, exceptIndex) {
    base = base || 'rabota';
    var taken = function (s) { return S.artworks.some(function (a, i) { return i !== exceptIndex && a.slug === s; }); };
    var s = base, n = 2;
    while (taken(s)) s = base + '-' + n++;
    return s;
  }
  function randomId() { return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5); }

  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // Уменьшаем фото до 2400px по длинной стороне и сохраняем в JPEG:
  // фото с телефона весит 3–8 МБ, после этого — около 0,5–1 МБ. Финальное сжатие делает сборка.
  function prepareImage(file) {
    var load = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: 'from-image' })
      : Promise.reject();
    return load.catch(function () {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('Не получается открыть «' + file.name + '». Сохраните фото в JPG или PNG и попробуйте снова.')); };
        img.src = URL.createObjectURL(file);
      });
    }).then(function (src) {
      var w = src.width, hgt = src.height;
      var k = Math.min(1, MAX_SIDE / Math.max(w, hgt));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(hgt * k);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Не удалось обработать фото')); }, 'image/jpeg', 0.88);
      });
    });
  }

  // ---------- Хранилище: локальная папка или GitHub ----------
  function localApi() {
    return {
      name: 'local',
      load: function () {
        return fetch('/api/content', { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('Не удалось загрузить данные с локального сервера');
          return r.json();
        });
      },
      save: function (p) {
        var uploads = [];
        var jobs = [];
        p.uploads.forEach(function (blob, path) {
          jobs.push(toBase64(blob).then(function (b64) { uploads.push({ path: path, base64: b64 }); }));
        });
        return Promise.all(jobs).then(function () {
          return fetch('/api/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ artworks: p.artworks, settings: p.settings, uploads: uploads, deletes: Array.from(p.deletes) })
          });
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok || !j.ok) throw new Error(j.error || 'Не удалось сохранить');
            return {};
          });
        });
      },
      photoUrl: function (p) { return '/api/file?path=' + encodeURIComponent('images/' + p); }
    };
  }

  function githubApi() {
    var repo = CFG.repo, branch = CFG.branch || 'main';
    var token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}

    function gh(path, opts) {
      opts = opts || {};
      var headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (opts.body) headers['Content-Type'] = 'application/json';
      return fetch('https://api.github.com/repos/' + repo + path, {
        method: opts.method || 'GET', headers: headers, cache: 'no-store',
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        if (r.ok) return r.status === 204 ? null : r.json();
        return r.json().catch(function () { return {}; }).then(function (j) {
          var msg = r.status === 401 ? 'Ключ доступа недействителен или истёк. Войдите заново.'
            : (r.status === 403 || r.status === 404) ? 'Нет доступа к репозиторию ' + repo + '. Проверьте права ключа.'
            : (j.message || 'Ошибка GitHub ' + r.status);
          var err = new Error(msg); err.status = r.status; throw err;
        });
      }, function () { throw new Error('Нет связи с GitHub. Проверьте интернет и попробуйте ещё раз.'); });
    }
    function readJson(path, ref) {
      return gh('/contents/' + path + '?ref=' + ref).then(function (f) { return JSON.parse(b64ToUtf8(f.content)); });
    }

    return {
      name: 'github',
      hasToken: function () { return !!token; },
      setToken: function (t) { token = t.trim(); try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {} },
      logout: function () { token = ''; try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} },
      load: function () {
        return gh('/git/ref/heads/' + branch).then(function (ref) {
          var sha = ref.object.sha;
          return Promise.all([readJson('content/artworks.json', sha), readJson('content/settings.json', sha)]).then(function (r) {
            return { artworks: r[0], settings: r[1], sha: sha };
          });
        });
      },
      save: function (p) {
        var head, baseTree;
        var tree = [
          { path: 'content/artworks.json', mode: '100644', type: 'blob', content: JSON.stringify(p.artworks, null, 2) + '\n' },
          { path: 'content/settings.json', mode: '100644', type: 'blob', content: JSON.stringify(p.settings, null, 2) + '\n' }
        ];
        return gh('/git/ref/heads/' + branch).then(function (ref) {
          head = ref.object.sha;
          if (p.baseSha && head !== p.baseSha) {
            var e = new Error('Пока вы редактировали, данные изменились (например, с другого устройства). Обновите страницу и повторите изменения — так ничего не потеряется.');
            e.conflict = true; throw e;
          }
          return gh('/git/commits/' + head);
        }).then(function (commit) {
          baseTree = commit.tree.sha;
          var chain = Promise.resolve();
          p.uploads.forEach(function (blob, path) {
            chain = chain.then(function () { return toBase64(blob); })
              .then(function (b64) { return gh('/git/blobs', { method: 'POST', body: { content: b64, encoding: 'base64' } }); })
              .then(function (b) { tree.push({ path: path, mode: '100644', type: 'blob', sha: b.sha }); });
          });
          return chain;
        }).then(function () {
          if (!p.deletes.size) return;
          return gh('/git/trees/' + baseTree + '?recursive=1').then(function (t) {
            var existing = new Set(t.tree.map(function (x) { return x.path; }));
            p.deletes.forEach(function (path) { if (existing.has(path)) tree.push({ path: path, mode: '100644', type: 'blob', sha: null }); });
          });
        }).then(function () {
          return gh('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: tree } });
        }).then(function (t) {
          return gh('/git/commits', { method: 'POST', body: { message: p.message, tree: t.sha, parents: [head] } });
        }).then(function (c) {
          return gh('/git/refs/heads/' + branch, { method: 'PATCH', body: { sha: c.sha } }).then(function () { return { sha: c.sha }; });
        });
      },
      deployStatus: function (sha) {
        return gh('/actions/runs?head_sha=' + sha + '&per_page=5').then(function (j) {
          var run = j.workflow_runs && j.workflow_runs[0];
          if (!run) return 'queued';
          if (run.status !== 'completed') return 'running';
          return run.conclusion === 'success' ? 'done' : 'failed';
        });
      },
      photoUrl: function (p) {
        return 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/images/' + p.split('/').map(encodeURIComponent).join('/');
      }
    };
  }

  var api = LOCAL ? localApi() : githubApi();
  var photoUrl = function (p) { return S.previews.get(p) || api.photoUrl(p); };

  // ---------- Каркас страницы ----------
  var app = document.getElementById('app');
  var topEl = h('header', { class: 'top' });
  var noticeEl = h('div', { class: 'notice', hidden: true });
  var mainEl = h('main');
  app.append(topEl, noticeEl, mainEl);

  function setNotice(type, text) {
    noticeEl.hidden = !text;
    noticeEl.replaceChildren(text ? h('div', { class: 'notice__box notice__box--' + type, role: type === 'err' ? 'alert' : 'status' },
      h('span', { class: 'notice__text' }, text),
      h('button', { class: 'notice__close', 'aria-label': 'Закрыть', onclick: function () { setNotice(null); } }, '×')) : '');
    if (text && type === 'err') noticeEl.scrollIntoView({ block: 'nearest' });
  }
  function setBusy(v) { S.busy = v; document.body.classList.toggle('is-busy', v); }

  function renderTop() {
    var logged = S.view !== 'login' && S.view !== 'nosetup';
    var tab = function (view, label) {
      return h('button', { class: 'tab', 'aria-current': (S.view === view || (view === 'list' && S.view === 'edit')) ? 'page' : null, onclick: function () { go(view); } }, label);
    };
    topEl.replaceChildren(h('div', { class: 'top__bar' },
      h('span', { class: 'brand' }, 'Zosya', h('small', {}, LOCAL ? 'админка · на компьютере' : 'админка')),
      logged ? h('nav', { class: 'tabs' }, tab('list', 'Работы'), tab('settings', 'Настройки сайта')) : null,
      h('div', { class: 'top__links' },
        h('a', { href: SITE_LINK, target: '_blank', rel: 'noopener' }, 'Сайт ↗'),
        api.name === 'github' && api.hasToken() ? h('button', { onclick: logout }, 'Выйти') : null)));
  }

  function render() {
    renderTop();
    var v = S.view;
    mainEl.replaceChildren(
      v === 'loading' ? h('p', { class: 'loading' }, 'Загрузка…')
        : v === 'login' ? loginView()
        : v === 'nosetup' ? h('div', { class: 'view' }, h('h1', {}, 'Админка ещё не подключена'), h('p', { class: 'hint' }, 'Нужно указать репозиторий GitHub в site.config.mjs (GITHUB_REPO) и пересобрать сайт.'))
        : v === 'error' ? h('div', { class: 'view' }, h('h1', {}, 'Не удалось загрузить данные'), h('p', {}, S.error || ''), h('div', {}, h('button', { class: 'btn', onclick: loadAll }, 'Попробовать ещё раз')))
        : v === 'edit' ? editView()
        : v === 'settings' ? settingsView()
        : listView());
  }

  function draftChanged() {
    return !!S.draft && (JSON.stringify(S.draft.data) !== S.draft.orig || S.draft.uploads.size > 0);
  }
  function hasUnsaved() { return S.dirty || draftChanged(); }
  function go(view) {
    if (view === S.view) return;
    if (draftChanged() && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
    S.draft = null;
    if (view === 'settings') openSettings();
    else { S.view = view; render(); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('beforeunload', function (e) { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- Загрузка и публикация ----------
  function loadAll() {
    S.view = 'loading'; render();
    return api.load().then(function (j) {
      S.artworks = j.artworks || [];
      S.settings = Object.assign({ usdRate: 80, telegram: '', instagram: '', pinterest: '', heroPhoto: '', aboutPhoto: '', customPhotos: [], metrikaId: '', ownerName: '', ownerEmail: '' }, j.settings);
      while (S.settings.customPhotos.length < 5) S.settings.customPhotos.push('');
      S.baseSha = j.sha || null;
      S.pending = { uploads: new Map(), deletes: new Set() };
      S.dirty = false;
      S.view = 'list';
      render();
    }).catch(function (e) {
      if (e.status === 401 && api.name === 'github') { api.logout(); S.view = 'login'; render(); setNotice('err', e.message); return; }
      S.view = 'error'; S.error = e.message; render();
    });
  }

  function referencedPhotos(artworks, settings) {
    var set = new Set();
    artworks.forEach(function (a) { (a.photos || []).forEach(function (p) { set.add(p); }); });
    [settings.heroPhoto, settings.aboutPhoto].concat(settings.customPhotos || []).forEach(function (p) { if (p) set.add(p); });
    return set;
  }

  // Одно сохранение = одна публикация: данные + новые фото + удалённые фото
  function publish(o) {
    if (S.busy) return Promise.resolve(false);
    var artworks = o.artworks || S.artworks;
    var settings = o.settings || S.settings;
    var allUploads = new Map(S.pending.uploads);
    (o.uploads || new Map()).forEach(function (b, p) { allUploads.set(p, b); });
    var allDeletes = new Set(S.pending.deletes);
    (o.removed || new Set()).forEach(function (p) { allDeletes.add(p); });
    var used = referencedPhotos(artworks, settings);
    var uploads = new Map(), deletes = new Set();
    allUploads.forEach(function (b, p) { if (used.has(p)) uploads.set('images/' + p, b); });
    allDeletes.forEach(function (p) { if (!used.has(p) && !allUploads.has(p)) deletes.add('images/' + p); });

    setBusy(true);
    setNotice('info', uploads.size ? 'Сохраняю и загружаю фото (' + uploads.size + ')…' : 'Сохраняю…');
    return api.save({ artworks: artworks, settings: settings, uploads: uploads, deletes: deletes, message: o.message, baseSha: S.baseSha })
      .then(function (res) {
        S.artworks = artworks; S.settings = settings;
        S.pending = { uploads: new Map(), deletes: new Set() };
        S.dirty = false;
        if (res.sha) S.baseSha = res.sha;
        if (api.name === 'github') watchDeploy(res.sha);
        else setNotice('ok', 'Сохранено, сайт пересобран.');
        return true;
      })
      .catch(function (e) { setNotice('err', e.message); return false; })
      .then(function (ok) { setBusy(false); return ok; });
  }

  // После сохранения GitHub пересобирает сайт; показываем, когда изменения появятся
  function watchDeploy(sha) {
    var started = Date.now();
    setNotice('ok', 'Сохранено. Сайт обновляется — обычно это 1–2 минуты…');
    (function poll() {
      if (Date.now() - started > 6 * 60 * 1000) return setNotice('ok', 'Сохранено. Сайт обновится в течение нескольких минут.');
      api.deployStatus(sha).then(function (st) {
        if (S.baseSha !== sha) return; // уже было новое сохранение
        if (st === 'done') setNotice('ok', 'Готово — изменения уже на сайте.');
        else if (st === 'failed') setNotice('err', 'Данные сохранены, но сайт не удалось обновить. Напишите разработчику — изменения не потеряются.');
        else setTimeout(poll, 7000);
      }).catch(function () {
        setNotice('ok', 'Сохранено. Сайт обновится через 1–2 минуты.');
      });
    })();
  }

  function logout() {
    if (hasUnsaved() && !confirm('Есть несохранённые изменения. Всё равно выйти?')) return;
    api.logout(); S.dirty = false; S.draft = null; S.view = 'login'; setNotice(null); render();
  }

  // ---------- Вход (только для сайта в интернете) ----------
  function loginView() {
    var input = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'github_pat_…' });
    var submit = function (e) {
      e.preventDefault();
      if (!input.value.trim()) return;
      api.setToken(input.value);
      setNotice(null);
      loadAll();
    };
    var tokenUrl = 'https://github.com/settings/personal-access-tokens/new';
    return h('div', { class: 'view login' },
      h('h1', {}, 'Вход в админку'),
      h('p', {}, 'Админка сохраняет изменения на GitHub, откуда сайт обновляется сам. Для входа нужен ключ доступа — его создают один раз на каждом устройстве:'),
      h('ol', {},
        h('li', {}, 'Откройте ', h('a', { href: tokenUrl, target: '_blank', rel: 'noopener' }, 'страницу создания ключа на GitHub'), ' (нужно войти в аккаунт).'),
        h('li', {}, 'Token name — например, ', h('code', {}, 'Админка сайта'), ', Expiration — 1 год.'),
        h('li', {}, 'Repository access → Only select repositories → ', h('code', {}, CFG.repo || '…'), '.'),
        h('li', {}, 'Permissions → Repository permissions: ', h('code', {}, 'Contents: Read and write'), ' и ', h('code', {}, 'Actions: Read-only'), '.'),
        h('li', {}, 'Нажмите Generate token, скопируйте ключ и вставьте ниже.')),
      h('form', { class: 'field', onsubmit: submit },
        h('span', { class: 'field__label' }, 'Ключ доступа'), input,
        h('span', { class: 'field__hint' }, 'Ключ хранится только в этом браузере. Никому его не пересылайте.'),
        h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Войти'))));
  }

  // ---------- Список работ ----------
  function markDirty() { S.dirty = true; render(); }
  function move(i, d) {
    var a = S.artworks.splice(i, 1)[0];
    S.artworks.splice(i + d, 0, a);
    markDirty();
  }
  function mini(photo, tone) {
    return h('span', { class: 'mini', style: '--tone:' + (tone || '#D9D2C4') }, photo ? h('img', { src: photoUrl(photo), alt: '', loading: 'lazy' }) : null);
  }

  function listView() {
    var rows = S.artworks.map(function (a, i) {
      var sold = a.status === 'sold';
      return h('div', { class: 'work' + (sold ? ' is-sold' : '') },
        h('button', { class: 'work__main', onclick: function () { openEdit(i); } },
          mini(a.photos && a.photos[0], a.tone),
          h('span', { class: 'work__txt' },
            h('span', { class: 'work__title' }, a.title.ru || 'Без названия'),
            h('span', { class: 'work__meta' }, a.w + ' × ' + a.h + ' см · ' + rub(a.price) + ' · ' + usd(usdOf(a)) + (a.photos && a.photos.length ? '' : ' · нет фото')))),
        h('button', {
          class: 'pill' + (sold ? ' pill--sold' : ''), title: 'Нажмите, чтобы поменять статус',
          onclick: function () { a.status = sold ? 'available' : 'sold'; markDirty(); }
        }, sold ? 'Продано' : 'В наличии'),
        h('div', { class: 'work__order' },
          h('button', { class: 'icon', 'aria-label': 'Поднять выше', title: 'Выше', disabled: i === 0, onclick: function () { move(i, -1); } }, '↑'),
          h('button', { class: 'icon', 'aria-label': 'Опустить ниже', title: 'Ниже', disabled: i === S.artworks.length - 1, onclick: function () { move(i, 1); } }, '↓')));
    });
    return h('div', { class: 'view' },
      h('div', { class: 'view__head' },
        h('h1', {}, 'Работы'),
        h('button', { class: 'btn', onclick: function () { openEdit(-1); } }, '+ Добавить работу')),
      S.artworks.length
        ? h('p', { class: 'hint' }, 'Порядок здесь — это порядок на сайте. Нажмите на работу, чтобы изменить её; на «В наличии / Продано» — чтобы сменить статус.')
        : h('p', { class: 'empty' }, 'Пока нет ни одной работы.'),
      h('div', { class: 'works' }, rows),
      S.dirty ? h('div', { class: 'bar' }, h('div', { class: 'bar__inner' },
        h('span', { class: 'bar__text' }, 'Есть неопубликованные изменения'),
        h('button', { class: 'btn btn--ghost', onclick: function () { if (confirm('Отменить изменения порядка и статусов?')) loadAll(); } }, 'Отменить'),
        h('button', { class: 'btn', onclick: function () { publish({ message: 'Порядок и статусы работ' }).then(function (ok) { if (ok) render(); }); } }, 'Опубликовать'))) : null);
  }

  // ---------- Общие поля формы ----------
  function field(label, control, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), control, hint ? h('span', { class: 'field__hint' }, hint) : null);
  }
  function textInput(obj, key, attrs, after) {
    return h('input', Object.assign({ class: 'input', value: obj[key] == null ? '' : obj[key], oninput: function (e) { obj[key] = e.target.value; if (after) after(); } }, attrs || {}));
  }
  function numInput(obj, key, attrs, after) {
    return h('input', Object.assign({
      class: 'input', type: 'number', inputmode: 'numeric', min: '0', step: '1',
      value: obj[key] == null ? '' : obj[key],
      oninput: function (e) { obj[key] = e.target.value === '' ? null : Number(e.target.value); if (after) after(); }
    }, attrs || {}));
  }
  function textArea(obj, key, attrs) {
    return h('textarea', Object.assign({ class: 'input', oninput: function (e) { obj[key] = e.target.value; } }, attrs || {}), obj[key] || '');
  }
  function section(title, hint) {
    return h('section', { class: 'section' }, h('h2', { class: 'section__title' }, title), hint ? h('p', { class: 'section__hint' }, hint) : null, [].slice.call(arguments, 2));
  }

  // Выбор файлов: из кнопки или перетаскиванием
  function filePicker(multiple, onFiles) {
    var input = h('input', { type: 'file', accept: 'image/*', multiple: multiple || null, hidden: true, onchange: function (e) { onFiles([].slice.call(e.target.files)); e.target.value = ''; } });
    return input;
  }
  function addPhotoFiles(files, ctx, limit, onAdded) {
    files = files.filter(function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name); });
    if (!files.length) return Promise.resolve();
    if (limit != null && files.length > limit) {
      setNotice('err', 'Можно добавить ещё ' + limit + ' фото.');
      files = files.slice(0, limit);
    }
    setNotice('info', 'Обрабатываю фото…');
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () { return prepareImage(f); }).then(function (blob) {
        var path = 'uploads/' + (ctx.prefix || 'photo') + '-' + randomId() + '.jpg';
        ctx.uploads.set(path, blob);
        S.previews.set(path, URL.createObjectURL(blob));
        onAdded(path);
      });
    });
    return chain.then(function () { setNotice(null); }, function (e) { setNotice('err', e.message); });
  }
  function dropZone(el, onFiles) {
    el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('is-drop'); });
    el.addEventListener('dragleave', function () { el.classList.remove('is-drop'); });
    el.addEventListener('drop', function (e) { e.preventDefault(); el.classList.remove('is-drop'); onFiles([].slice.call(e.dataTransfer.files)); });
  }
  function removePhoto(ctx, p) {
    if (ctx.uploads.has(p)) ctx.uploads.delete(p);
    else ctx.removed.add(p);
  }

  // ---------- Работа: добавление и редактирование ----------
  function openEdit(i) {
    var src = i >= 0 ? S.artworks[i] : {
      slug: '', title: { ru: '', en: '' }, cats: [], w: null, h: null, framed: true,
      price: null, priceUsd: null, status: 'available', photos: [], desc: { ru: '', en: '' },
      tone: (CFG.tones || ['#D9D2C4'])[S.artworks.length % (CFG.tones || [1]).length]
    };
    // Фиксированный порядок полей — чтобы content/artworks.json было удобно читать
    var c = clone(src);
    var data = {
      slug: c.slug || '', title: c.title || { ru: '', en: '' }, cats: c.cats || [],
      w: c.w == null ? null : c.w, h: c.h == null ? null : c.h, framed: !!c.framed,
      price: c.price == null ? null : c.price, priceUsd: c.priceUsd || null, status: c.status || 'available',
      photos: c.photos || [], desc: c.desc || { ru: '', en: '' }, tone: c.tone
    };
    S.draft = { index: i, isNew: i < 0, data: data, orig: JSON.stringify(data), uploads: new Map(), removed: new Set(), slugTouched: i >= 0 };
    S.view = 'edit';
    setNotice(null);
    render();
    window.scrollTo(0, 0);
  }

  // Строка со ссылкой и кнопкой «Скопировать»
  function copyLine(label, url) {
    var btn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: function () {
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { btn.textContent = 'Скопировано'; setTimeout(function () { btn.textContent = 'Скопировать'; }, 2000); }, function () { prompt('Скопируйте ссылку:', url); });
    } }, 'Скопировать');
    return h('div', { class: 'copyline' }, h('span', { class: 'field__label' }, label), h('div', { class: 'copyline__row' }, h('input', { class: 'input', value: url, readonly: true, onfocus: function (e) { e.target.select(); } }), btn));
  }

  function editView() {
    var d = S.draft, a = d.data;

    // Адрес страницы
    var slugInput = h('input', { class: 'input', value: a.slug, oninput: function (e) { d.slugTouched = true; a.slug = slugify(e.target.value) || ''; } , onblur: function (e) { e.target.value = a.slug; } });
    var syncSlug = function () {
      if (d.slugTouched || !d.isNew) return;
      a.slug = uniqueSlug(slugify(a.title.en) || slugify(a.title.ru), -1);
      slugInput.value = a.slug;
    };
    var slugBlock = d.isNew
      ? field('Адрес страницы', h('div', { class: 'affix' }, h('span', {}, SITE_HOST + '/en/art/'), slugInput),
          'Заполнится сам из английского названия. Его стоит выбрать один раз: на этот адрес будут вести пины в Pinterest.')
      : h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Адрес страницы'),
          h('p', { class: 'url' }, SITE_HOST + '/…/art/', h('b', {}, a.slug + '/'), ' · ',
            h('a', { href: artUrl('ru', a.slug), target: '_blank', rel: 'noopener' }, 'по-русски ↗'), ' · ',
            h('a', { href: artUrl('en', a.slug), target: '_blank', rel: 'noopener' }, 'по-английски ↗')),
          copyLine('Ссылка для пина в Pinterest (английская версия)', publicArtUrl('en', a.slug)),
          h('span', { class: 'field__hint' }, 'Адрес не меняется, чтобы не сломать ссылки из Pinterest.'));

    // Цена в долларах: подсказка с автоматическим пересчётом
    var usdInput = numInput(a, 'priceUsd', {});
    var usdHint = h('span', { class: 'field__hint' });
    var syncUsd = function () {
      var auto = autoUsd(a.price);
      usdInput.placeholder = auto ? 'авто: ' + usd(auto) : 'авто';
      usdHint.textContent = 'Если оставить пустым — посчитается по курсу 1 $ = ' + S.settings.usdRate + ' ₽' + (auto ? ' (сейчас ' + usd(auto) + ')' : '') + '. Курс меняется в настройках сайта.';
    };
    syncUsd();

    // Фото
    var photosBox = h('div', { class: 'photos' });
    var ctx = { uploads: d.uploads, removed: d.removed, get prefix() { return a.slug || slugify(a.title.en || a.title.ru) || 'photo'; } };
    var picker = filePicker(true, function (files) { addPhotoFiles(files, ctx, MAX_PHOTOS - a.photos.length, function (p) { a.photos.push(p); drawPhotos(); }); });
    function drawPhotos() {
      var tiles = a.photos.map(function (p, i) {
        return h('div', { class: 'photo', style: '--tone:' + a.tone },
          h('img', { src: photoUrl(p), alt: '' }),
          i === 0 ? h('span', { class: 'photo__tag' }, 'Главное') : null,
          h('div', { class: 'photo__tools' },
            h('button', { type: 'button', title: 'Левее', 'aria-label': 'Сдвинуть левее', disabled: i === 0, onclick: function () { a.photos.splice(i - 1, 0, a.photos.splice(i, 1)[0]); drawPhotos(); } }, '←'),
            h('button', { type: 'button', title: 'Правее', 'aria-label': 'Сдвинуть правее', disabled: i === a.photos.length - 1, onclick: function () { a.photos.splice(i + 1, 0, a.photos.splice(i, 1)[0]); drawPhotos(); } }, '→'),
            h('button', { type: 'button', class: 'del', title: 'Удалить фото', 'aria-label': 'Удалить фото', onclick: function () { removePhoto(ctx, p); a.photos.splice(i, 1); drawPhotos(); } }, '✕')));
      });
      photosBox.replaceChildren.apply(photosBox, tiles.concat(a.photos.length < MAX_PHOTOS
        ? [h('button', { type: 'button', class: 'add', onclick: function () { picker.click(); } }, h('strong', {}, '+'), 'Добавить фото', h('span', { class: 'field__hint' }, 'или перетащите сюда'))]
        : []));
    }
    dropZone(photosBox, function (files) { addPhotoFiles(files, ctx, MAX_PHOTOS - a.photos.length, function (p) { a.photos.push(p); drawPhotos(); }); });
    drawPhotos();

    // Категории
    var cats = h('div', { class: 'cats' }, (CFG.cats || []).map(function (c) {
      return h('label', {}, h('input', {
        type: 'checkbox', checked: a.cats.indexOf(c.key) >= 0,
        onchange: function (e) { a.cats = e.target.checked ? a.cats.concat(c.key) : a.cats.filter(function (x) { return x !== c.key; }); }
      }), h('span', {}, c.label));
    }));

    var status = h('div', { class: 'seg', role: 'radiogroup' }, [['available', 'В наличии'], ['sold', 'Продано']].map(function (s) {
      return h('label', {}, h('input', { type: 'radio', name: 'status', value: s[0], checked: a.status === s[0], onchange: function () { a.status = s[0]; } }), h('span', {}, s[1]));
    }));

    return h('div', { class: 'view' },
      h('div', { class: 'view__head' },
        h('h1', {}, d.isNew ? 'Новая работа' : (a.title.ru || 'Работа')),
        h('button', { class: 'btn btn--ghost', onclick: function () { go('list'); } }, '← Все работы')),
      h('div', { class: 'form' },
        section('Фото', 'Первое фото — главное: оно в каталоге и в превью для Pinterest. Дальше: фактура крупно, работа в интерьере, рама. До ' + MAX_PHOTOS + ' фото, можно прямо с телефона.',
          photosBox, picker),
        section('Название', null,
          h('div', { class: 'row' },
            field('По-русски', textInput(a.title, 'ru', { placeholder: 'Кошка в красных очках' }, syncSlug)),
            field('По-английски', textInput(a.title, 'en', { placeholder: 'Cat in Red Glasses' }, syncSlug))),
          slugBlock),
        section('Размер и цена', null,
          h('div', { class: 'row row--narrow' },
            field('Ширина, см', numInput(a, 'w', { placeholder: '40' })),
            field('Высота, см', numInput(a, 'h', { placeholder: '50' })),
            field('Цена, ₽', numInput(a, 'price', { placeholder: '22000', step: '100' }, syncUsd)),
            field('Цена, $ (для английской версии)', usdInput)),
          usdHint,
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!a.framed, onchange: function (e) { a.framed = e.target.checked; } }), 'В раме')),
        section('Статус', 'Проданная работа остаётся на сайте приглушённой, вместо «Купить» — «Заказать похожую».', h('div', {}, status)),
        section('Темы', 'По ним работает фильтр в каталоге. Можно выбрать несколько.', cats),
        section('Описание', 'Пара предложений о работе: ткани, цвета, настроение. Показывается в блоке «О работе».',
          h('div', { class: 'row' },
            field('По-русски', textArea(a.desc, 'ru')),
            field('По-английски', textArea(a.desc, 'en')))),
        d.isNew ? null : h('div', { class: 'danger-zone' }, h('button', { class: 'btn btn--danger', onclick: deleteWork }, 'Удалить работу'))),
      h('div', { class: 'bar' }, h('div', { class: 'bar__inner' },
        h('span', { class: 'bar__text' }, 'Изменения появятся на сайте после сохранения'),
        h('button', { class: 'btn btn--ghost', onclick: function () { go('list'); } }, 'Отмена'),
        h('button', { class: 'btn', onclick: saveWork }, d.isNew ? 'Добавить на сайт' : 'Сохранить'))));
  }

  function validateWork(a, index) {
    var errs = [];
    if (!a.title.ru.trim()) errs.push('название по-русски');
    if (!a.title.en.trim()) errs.push('название по-английски');
    if (!(a.w > 0) || !(a.h > 0)) errs.push('размер');
    if (!(a.price > 0)) errs.push('цену в рублях');
    var out = errs.length ? ['Заполните: ' + errs.join(', ') + '.'] : [];
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug)) out.push('Адрес страницы: только латинские буквы, цифры и дефис.');
    else if (S.artworks.some(function (o, i) { return i !== index && o.slug === a.slug; })) out.push('Адрес «' + a.slug + '» уже занят другой работой.');
    return out;
  }

  function saveWork() {
    var d = S.draft, a = d.data;
    a.title.ru = a.title.ru.trim(); a.title.en = a.title.en.trim();
    a.desc.ru = (a.desc.ru || '').trim(); a.desc.en = (a.desc.en || '').trim();
    if (!(a.priceUsd > 0)) a.priceUsd = null;
    if (d.isNew && !a.slug) a.slug = uniqueSlug(slugify(a.title.en) || slugify(a.title.ru), -1);
    var errs = validateWork(a, d.index);
    if (errs.length) return setNotice('err', errs.join('\n'));
    if (!a.photos.length && !confirm('У работы нет ни одного фото — на сайте будет заглушка. Всё равно сохранить?')) return;
    var artworks = S.artworks.slice();
    if (d.isNew) artworks.unshift(a); else artworks[d.index] = a;
    publish({ artworks: artworks, uploads: d.uploads, removed: d.removed, message: (d.isNew ? 'Новая работа: ' : 'Работа: ') + a.title.ru })
      .then(function (ok) { if (ok) { S.draft = null; S.view = 'list'; render(); window.scrollTo(0, 0); } });
  }

  function deleteWork() {
    var d = S.draft, a = S.artworks[d.index];
    if (!confirm('Удалить «' + a.title.ru + '» с сайта? Страница работы перестанет открываться.\n\nЕсли работа продана, лучше отметить её «Продано» — тогда ссылки из Pinterest продолжат работать.')) return;
    var artworks = S.artworks.filter(function (_, i) { return i !== d.index; });
    publish({ artworks: artworks, removed: new Set(a.photos), message: 'Удалена работа: ' + a.title.ru })
      .then(function (ok) { if (ok) { S.draft = null; S.view = 'list'; render(); } });
  }

  // ---------- Настройки сайта ----------
  function openSettings() {
    var data = clone(S.settings);
    S.draft = { settings: true, data: data, orig: JSON.stringify(data), uploads: new Map(), removed: new Set() };
    S.view = 'settings';
    setNotice(null);
    render();
  }

  function singlePhoto(d, obj, key, prefix) {
    var box = h('div', { class: 'single' });
    var ctx = { uploads: d.uploads, removed: d.removed, prefix: prefix };
    var onFiles = function (files) {
      addPhotoFiles(files.slice(0, 1), ctx, 1, function (p) {
        if (obj[key]) removePhoto(ctx, obj[key]);
        obj[key] = p; draw();
      });
    };
    var picker = filePicker(false, onFiles);
    function draw() {
      var p = obj[key];
      box.replaceChildren(
        p ? h('div', { class: 'photo' }, h('img', { src: photoUrl(p), alt: '' }))
          : h('button', { type: 'button', class: 'add', onclick: function () { picker.click(); } }, h('strong', {}, '+'), 'Фото'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn--ghost', onclick: function () { picker.click(); } }, p ? 'Заменить' : 'Выбрать фото'),
          p ? h('button', { type: 'button', class: 'btn btn--ghost', onclick: function () { removePhoto(ctx, p); obj[key] = ''; draw(); } }, 'Убрать') : null),
        picker);
    }
    dropZone(box, onFiles);
    draw();
    return box;
  }

  function settingsView() {
    var d = S.draft, s = d.data;
    var handleIn = function (key) {
      return h('div', { class: 'affix' }, h('span', {}, '@'), h('input', {
        class: 'input', value: s[key] || '',
        oninput: function (e) { s[key] = e.target.value.trim().replace(/^https?:\/\/(www\.)?[^/]+\//, '').replace(/^@/, '').replace(/[/?#].*$/, ''); }
      }));
    };
    return h('div', { class: 'view' },
      h('div', { class: 'view__head' }, h('h1', {}, 'Настройки сайта')),
      h('div', { class: 'form' },
        section('Цены в долларах', 'В английской версии цены показываются в долларах. Если у работы не указана своя цена в $, она считается по этому курсу и округляется до $5–10.',
          h('div', { class: 'row row--narrow' },
            field('Курс', h('div', { class: 'affix' }, h('span', {}, '1 $ ='), numInput(s, 'usdRate', { step: '0.5' }), h('span', {}, '₽'))))),
        section('Контакты', 'Куда ведут кнопки «Купить», «Обсудить заказ» и ссылки в подвале.',
          h('div', { class: 'row' },
            field('Telegram', handleIn('telegram')),
            field('Instagram', handleIn('instagram'))),
          field('Pinterest (ссылка на профиль)', textInput(s, 'pinterest', { type: 'url', placeholder: 'https://ru.pinterest.com/…' }))),
        section('Статистика — Яндекс Метрика', 'Номер счётчика из metrika.yandex.ru (только цифры). Пока поле пустое, статистика не собирается и баннер о cookies не показывается.',
          h('div', { class: 'row row--narrow' }, field('Номер счётчика', textInput(s, 'metrikaId', { inputmode: 'numeric', placeholder: '12345678' })))),
        section('Политика конфиденциальности', 'Кто отвечает за данные посетителей и куда писать по вопросам о них. Показывается на странице «Политика конфиденциальности».',
          h('div', { class: 'row' },
            field('Имя владельца сайта', textInput(s, 'ownerName', { placeholder: 'Татьяна …' }), 'Если пусто — «Татьяна, автор ZosyaHandmadePictures».'),
            field('Email для вопросов о данных', textInput(s, 'ownerEmail', { type: 'email', placeholder: 'name@example.com' }), 'Если пусто — указывается Telegram.'))),
        section('Фото первого экрана', 'Большое фото одной из лучших работ вверху главной страницы. Лучше горизонтальное.',
          singlePhoto(d, s, 'heroPhoto', 'hero')),
        section('Фото «Обо мне»', 'Портрет или фото за работой.', singlePhoto(d, s, 'aboutPhoto', 'about')),
        section('Примеры в блоке «На заказ»', 'Показывают, какие работы можно заказать.',
          h('div', { class: 'row' }, (CFG.kinds || []).map(function (label, i) {
            return h('div', { class: 'field' }, h('span', { class: 'field__label' }, label), singlePhoto(d, s.customPhotos, i, 'custom'));
          })))),
      h('div', { class: 'bar' }, h('div', { class: 'bar__inner' },
        h('span', { class: 'bar__text' }, 'Изменения появятся на сайте после сохранения'),
        h('button', { class: 'btn', onclick: saveSettings }, 'Сохранить'))));
  }

  function saveSettings() {
    var d = S.draft, s = d.data;
    if (!(s.usdRate > 0)) return setNotice('err', 'Укажите курс доллара.');
    if (!s.telegram) return setNotice('err', 'Укажите Telegram — на него ведёт кнопка «Купить».');
    s.metrikaId = String(s.metrikaId || '').trim();
    if (s.metrikaId && !/^\d{5,12}$/.test(s.metrikaId)) return setNotice('err', 'Номер счётчика Метрики — только цифры, например 12345678.');
    publish({ settings: s, uploads: d.uploads, removed: d.removed, message: 'Настройки сайта' })
      .then(function (ok) { if (ok) { d.orig = JSON.stringify(s); d.uploads = new Map(); d.removed = new Set(); openSettings(); } });
  }

  // ---------- Старт ----------
  if (!LOCAL && !CFG.repo) { S.view = 'nosetup'; render(); }
  else if (api.name === 'github' && !api.hasToken()) { S.view = 'login'; render(); }
  else loadAll();
})();
