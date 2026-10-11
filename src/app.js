(function () {
  var html = document.documentElement;
  var LANG_KEY = 'zosya-lang';
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lang = function () { return html.lang === 'en' ? 'en' : 'ru'; };

  // ---------- Язык ----------
  function setLang(l, save) {
    html.lang = l;
    document.querySelectorAll('[data-set-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.setLang === l));
    });
    document.querySelectorAll('[data-aria-ru]').forEach(function (el) {
      el.setAttribute('aria-label', el.getAttribute('data-aria-' + l));
    });
    if (save) { try { localStorage.setItem(LANG_KEY, l); } catch (e) {} }
  }
  document.querySelectorAll('[data-set-lang]').forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.dataset.setLang, true); });
  });
  setLang(lang(), false);

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
  function withMessage(link, text) {
    copyText(text);
    // Telegram умеет подставлять текст в поле ввода по ссылке t.me/username?text=...
    if (/^https:\/\/t\.me\//.test(link.href)) {
      link.href = link.href.split('?')[0] + '?text=' + encodeURIComponent(text);
    }
    showToast();
  }
  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[data-msg-ru], a[data-sheet-msg]');
    if (!link) return;
    var text = link.hasAttribute('data-sheet-msg') ? sheetMsg[lang()] : link.getAttribute('data-msg-' + lang());
    if (text) withMessage(link, text);
  });

  // ---------- Окно «Где вам удобно написать?» ----------
  var sheet = document.getElementById('sheet');
  var sheetMsg = { ru: '', en: '' };
  var lastFocus = null;
  function bilingual(el, ru, en) {
    el.textContent = '';
    [['ru', ru], ['en', en]].forEach(function (p) {
      var s = document.createElement('span');
      s.setAttribute('data-l', p[0]);
      s.textContent = p[1];
      el.appendChild(s);
    });
  }
  function openSheet(btn) {
    if (!sheet) return;
    var d = btn.dataset;
    bilingual(sheet.querySelector('.sheet__sub'), d.titleRu + ' · ' + d.priceRu, d.titleEn + ' · ' + d.priceEn);
    sheetMsg = { ru: d.msgRu, en: d.msgEn };
    bilingual(sheet.querySelector('.sheet__msg-text'), d.msgRu, d.msgEn);
    lastFocus = btn;
    sheet.classList.remove('is-closing');
    sheet.hidden = false;
    document.body.classList.add('no-scroll');
    sheet.querySelector('.sheet__close').focus({ preventScroll: true });
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
      if (e.target.closest('.sheet__copy')) { copyText(sheetMsg[lang()]); showToast(); }
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
        main.querySelector('.ph__label').innerHTML = 'photo · ' + th.querySelector('.ph__label').innerHTML;
      }
    });
  });
})();
