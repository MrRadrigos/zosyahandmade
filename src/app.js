(function () {
  var html = document.documentElement;
  var LANG_KEY = 'zosya-lang';
  var CONSENT_KEY = 'zosya-consent';
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  };

  // ---------- Язык ----------
  // У каждой страницы свой язык и адрес (/ru/…, /en/…); запоминаем выбор, чтобы корень сайта открывал нужную версию
  document.querySelectorAll('[data-lang-link]').forEach(function (a) {
    a.addEventListener('click', function () { store.set(LANG_KEY, a.dataset.langLink); });
  });
  // Страница 404 одна на оба языка — там язык переключается без перехода
  document.querySelectorAll('[data-set-lang]').forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.setLang === html.lang));
    b.addEventListener('click', function () {
      html.lang = b.dataset.setLang;
      store.set(LANG_KEY, html.lang);
      document.querySelectorAll('[data-set-lang]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    });
  });

  // ---------- Яндекс Метрика: только после согласия ----------
  var YM = +html.dataset.ym || 0;
  function loadMetrika() {
    if (!YM || window.ym) return;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
    window.ym(YM, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
  }
  // Цели: сколько людей открыло окно покупки, перешло в мессенджер, скопировало сообщение
  function goal(name, params) {
    if (YM && window.ym) window.ym(YM, 'reachGoal', name, params || {});
  }
  var consent = document.getElementById('consent');
  if (YM) {
    var choice = store.get(CONSENT_KEY);
    if (choice === 'yes') loadMetrika();
    else if (!choice && consent) consent.hidden = false;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-consent]');
    if (b) {
      store.set(CONSENT_KEY, b.dataset.consent);
      consent.hidden = true;
      if (b.dataset.consent === 'yes') loadMetrika();
    }
    if (e.target.closest('[data-consent-reset]')) {
      store.set(CONSENT_KEY, null);
      if (consent) consent.hidden = false;
      var done = document.getElementById('consent-reset-done');
      if (done) done.hidden = false;
    }
  });

  // ---------- Появление блоков при прокрутке ----------
  var reveals = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || reduceMotion) {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  // ---------- Мобильное меню ----------
  var burger = document.querySelector('.burger');
  var mnav = document.querySelector('.mnav');
  if (burger && mnav) {
    burger.addEventListener('click', function () {
      var open = mnav.hidden;
      mnav.hidden = !open;
      burger.setAttribute('aria-expanded', String(open));
    });
    mnav.addEventListener('click', function (e) {
      if (e.target.closest('a')) { mnav.hidden = true; burger.setAttribute('aria-expanded', 'false'); }
    });
  }

  // ---------- Фильтр по темам ----------
  var chips = document.querySelectorAll('.chip');
  var cards = document.querySelectorAll('#cards .card');
  var empty = document.getElementById('empty');
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var cat = chip.dataset.cat;
      chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      var shown = 0;
      cards.forEach(function (card) {
        var ok = cat === 'all' || card.dataset.cats.split(' ').indexOf(cat) >= 0;
        card.hidden = !ok;
        card.classList.remove('is-shown');
        if (ok) {
          shown++;
          card.classList.add('is-in');
          void card.offsetWidth; // перезапуск анимации
          card.classList.add('is-shown');
        }
      });
      if (empty) empty.hidden = shown > 0;
    });
  });

  // ---------- Готовое сообщение: копируем в буфер и подставляем в Telegram ----------
  var toast = document.getElementById('toast');
  var toastTimer;
  function showToast() {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.classList.remove('is-hiding');
    toast.hidden = false;
    toastTimer = setTimeout(function () {
      toast.classList.add('is-hiding');
      toastTimer = setTimeout(function () { toast.hidden = true; toast.classList.remove('is-hiding'); }, 300);
    }, 4000);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }
  var sheet = document.getElementById('sheet');
  var sheetData = { msg: '', slug: '' };
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href^="https://t.me/"], a[href^="https://instagram.com/"]');
    if (!link) return;
    var tg = /^https:\/\/t\.me\//.test(link.href);
    var inSheet = link.hasAttribute('data-sheet-msg');
    var text = inSheet ? sheetData.msg : link.dataset.msg;
    var slug = inSheet ? sheetData.slug : link.dataset.slug;
    goal(tg ? 'telegram_click' : 'instagram_click', slug ? { artwork: slug } : {});
    if (!text) return;
    copyText(text);
    // Telegram умеет подставлять текст в поле ввода по ссылке t.me/username?text=...
    if (tg) link.href = link.href.split('?')[0] + '?text=' + encodeURIComponent(text);
    showToast();
  });

  // ---------- Окно «Где вам удобно написать?» ----------
  var lastFocus = null;
  function openSheet(btn) {
    if (!sheet) return;
    var d = btn.dataset;
    sheet.querySelector('.sheet__sub').textContent = d.title + ' · ' + d.price;
    sheet.querySelector('.sheet__msg-text').textContent = d.msg;
    sheetData = { msg: d.msg, slug: d.slug };
    lastFocus = btn;
    sheet.classList.remove('is-closing');
    sheet.hidden = false;
    document.body.classList.add('no-scroll');
    sheet.querySelector('.sheet__close').focus({ preventScroll: true });
    goal('buy_open', { artwork: d.slug });
  }
  function closeSheet() {
    if (!sheet || sheet.hidden || sheet.classList.contains('is-closing')) return;
    var done = function () {
      sheet.hidden = true;
      sheet.classList.remove('is-closing');
      document.body.classList.remove('no-scroll');
      if (lastFocus) lastFocus.focus({ preventScroll: true });
    };
    if (reduceMotion) return done();
    sheet.classList.add('is-closing');
    setTimeout(done, 240);
  }
  document.querySelectorAll('[data-buy]').forEach(function (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); openSheet(btn); });
  });
  if (sheet) {
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet || e.target.closest('.sheet__close')) closeSheet();
      if (e.target.closest('.sheet__copy')) {
        copyText(sheetData.msg);
        showToast();
        goal('message_copy', { artwork: sheetData.slug });
      }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  }

  // ---------- Галерея на странице картины ----------
  var main = document.querySelector('.gallery__main');
  var thumbs = document.querySelectorAll('.thumb');
  thumbs.forEach(function (th) {
    th.addEventListener('click', function () {
      if (th.getAttribute('aria-pressed') === 'true') return;
      thumbs.forEach(function (t) { t.setAttribute('aria-pressed', String(t === th)); });
      var img = main.querySelector('img');
      if (th.dataset.src && img) {
        main.classList.add('is-switching');
        setTimeout(function () {
          img.onload = img.onerror = function () { main.classList.remove('is-switching'); };
          img.style.maxWidth = 'min(100%,' + th.dataset.w + 'px)';
          img.width = th.dataset.w; img.height = th.dataset.h;
          img.srcset = th.dataset.srcset;
          img.src = th.dataset.src;
        }, reduceMotion ? 0 : 200);
      } else {
        main.querySelector('.ph__label').textContent = 'photo · ' + th.querySelector('.ph__label').textContent;
      }
    });
  });
})();
