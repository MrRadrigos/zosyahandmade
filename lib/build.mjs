// Сборка статического сайта в папку dist/.
// Каждая страница собирается на двух языках со своими адресами:
//   /ru/ и /en/ — главная, /ru/art/<slug>/ и /en/art/<slug>/ — картина, /ru/privacy/ и /en/privacy/ — политика.
// Корень / отправляет посетителя на его язык. Адреса не зависят от домена — при переезде на .com не меняются.
// Данные берутся из content/*.json (их редактирует админка), тексты — из data/i18n.mjs.
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { processImages } from './images.mjs';
import { CATS, CUSTOM_TONES, GITHUB_BRANCH, GITHUB_REPO, SITE_URL, TONES } from '../site.config.mjs';
import { T } from '../data/i18n.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BRAND = 'ZosyaHandmadePictures';
const LANGS = ['ru', 'en'];
const LOCALE = { ru: 'ru_RU', en: 'en_US' };

const SIZES = {
  card: '(min-width: 1240px) 384px, (min-width: 960px) 31vw, (min-width: 560px) 48vw, 100vw',
  main: '(min-width: 1240px) 640px, (min-width: 960px) 52vw, 100vw',
  hero: '(min-width: 1240px) 1240px, 100vw',
  about: '(min-width: 960px) 560px, 100vw',
  kind: '(min-width: 960px) 220px, 45vw',
  thumb: '(min-width: 960px) 150px, 25vw'
};

// ---------- Помощники ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nb = s => s.replace(/[\s  ,]/g, ' ');
const rub = n => nb(Math.round(n).toLocaleString('ru-RU')) + ' ₽';
const usd = n => '$' + Math.round(n).toLocaleString('en-US');
const roundUsd = x => x < 100 ? Math.max(5, Math.round(x / 5) * 5) : Math.round(x / 10) * 10;
const handle = s => String(s || '').trim().replace(/^https?:\/\/(www\.)?[^/]+\//, '').replace(/^@/, '').replace(/[/?#].*$/, '');
const absUrl = path => SITE_URL + '/' + path.replace(/^\//, '');
// «Продано» и «Не продаётся» ведут себя одинаково: работу нельзя купить, можно заказать похожую
const isSold = a => a.status !== 'available';
const statusKey = a => a.status === 'private' ? 'notForSale' : a.status === 'sold' ? 'sold' : 'available';
const hasPrice = a => a.price > 0;
const forSale = a => a.status !== 'private';
const hasSize = a => a.w > 0 && a.h > 0;
const json = o => JSON.stringify(o).replace(/</g, '\\u003c');

// Оба языка в одном месте — только для страницы 404 (она одна на любой адрес); язык выбирает скрипт
const L = (ru, en) => ru === en ? esc(ru) : `<span data-l="ru">${esc(ru)}</span><span data-l="en">${esc(en)}</span>`;
const tl = key => L(T.ru[key], T.en[key]);

// Выбор языка для корня и старых адресов: сохранённый → язык браузера
const LANG_PICK = `var l;try{l=localStorage.getItem('zosya-lang')}catch(e){}if(l!=='ru'&&l!=='en')l=/^(ru|uk|be|kk)/i.test(navigator.language||'')?'ru':'en';`;

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// ---------- Данные ----------
async function loadContent() {
  const artworks = JSON.parse(await readFile(join(ROOT, 'content', 'artworks.json'), 'utf8'));
  const settings = JSON.parse(await readFile(join(ROOT, 'content', 'settings.json'), 'utf8'));
  return { artworks, settings };
}

export function validate(artworks, settings) {
  const slugs = new Set();
  artworks.forEach((a, i) => {
    const name = `работа №${i + 1} (${a.title?.ru || a.slug || 'без названия'})`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.slug || '')) throw new Error(`${name}: адрес «${a.slug}» — только латиница, цифры и дефис`);
    if (slugs.has(a.slug)) throw new Error(`${name}: адрес «${a.slug}» уже занят другой работой`);
    slugs.add(a.slug);
    if (!a.title?.ru || !a.title?.en) throw new Error(`${name}: нужно название на русском и английском`);
    // Цена и размер необязательны: без цены на сайте «Цена по запросу», без размера строка размера скрыта
    if (a.price != null && !(a.price > 0)) throw new Error(`${name}: цена должна быть больше нуля или пустой`);
    if ((a.w != null || a.h != null) && !(a.w > 0 && a.h > 0)) throw new Error(`${name}: укажите и ширину, и высоту — или оставьте обе пустыми`);
    for (const c of a.cats || []) if (!CATS.includes(c)) throw new Error(`${name}: неизвестная категория «${c}»`);
    if (!['available', 'sold', 'private'].includes(a.status)) throw new Error(`${name}: статус должен быть available, sold или private`);
  });
  if (!(settings.usdRate > 0)) throw new Error('Настройки: не указан курс доллара');
  if (settings.metrikaId && !/^\d{5,12}$/.test(String(settings.metrikaId).trim())) throw new Error('Настройки: номер счётчика Метрики — только цифры');
}

// ---------- Сборка ----------
export async function build({ log = console.log } = {}) {
  const { artworks: rawArtworks, settings } = await loadContent();
  validate(rawArtworks, settings);

  const artworks = rawArtworks.map((a, i) => ({
    cats: [], photos: [], desc: { ru: '', en: '' }, priceUsd: null, framed: false,
    ...a,
    tone: a.tone || TONES[i % TONES.length]
  }));
  const C = {
    tg: `https://t.me/${handle(settings.telegram)}`,
    tgHandle: '@' + handle(settings.telegram),
    ig: `https://instagram.com/${handle(settings.instagram)}`,
    igHandle: '@' + handle(settings.instagram),
    pinterest: settings.pinterest || 'https://pinterest.com'
  };
  const YM = String(settings.metrikaId || '').trim();
  const usdOf = a => a.priceUsd > 0 ? a.priceUsd : hasPrice(a) ? roundUsd(a.price / settings.usdRate) : null;

  // Метка версии в адресе стилей и скриптов: после обновления браузеры сразу берут свежие файлы, а не из кэша
  const hash = async (...files) => {
    const h = createHash('sha1');
    for (const f of files) h.update(await readFile(f));
    return h.digest('hex').slice(0, 8);
  };
  const V = { css: await hash(join(ROOT, 'src', 'styles.css')), js: await hash(join(ROOT, 'src', 'app.js')) };

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Шрифты — со своего сервера (без Google Fonts: быстрее и без передачи данных посетителей третьим лицам)
  V.fonts = await buildFonts(DIST);

  // Фото: все размеры готовим заранее, дальше шаблоны берут их из карты IMG
  const allPhotos = [
    ...artworks.flatMap(a => a.photos),
    settings.heroPhoto, settings.aboutPhoto, ...(settings.customPhotos || [])
  ];
  const IMG = await processImages(allPhotos, { root: ROOT, dist: DIST });

  // natural: не растягивать фото больше его настоящего размера (для фото, показанных целиком)
  function pic(photo, { sizes, alt = '', eager = false, natural = false }) {
    const info = IMG.get(photo);
    if (!info) return '';
    const srcset = info.widths.map(w => `/img/${info.base}-${w}.webp ${w}w`).join(', ');
    const fallback = info.widths.find(w => w >= 800) ?? info.widths[info.widths.length - 1];
    const style = natural ? ` style="max-width:min(100%,${info.width}px)"` : '';
    return `<img src="/img/${info.base}-${fallback}.webp" srcset="${srcset}" sizes="${sizes}" width="${info.width}" height="${info.height}" alt="${esc(alt)}"${style}${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
  }
  const ogImage = photo => IMG.has(photo) ? absUrl(`img/${IMG.get(photo).base}-og.jpg`) : '';
  const cover = settings.heroPhoto || artworks.find(a => a.photos[0])?.photos[0];

  // fit: работа видна целиком (без обрезки) на светлой подложке; иначе фото заполняет блок
  function ph({ photo, tone, label = '', cls = '', alt = '', sizes = '100vw', eager = false, vt = '', fit = false, natural = false }) {
    const img = photo ? pic(photo, { sizes, alt, eager, natural }) : '';
    const style = `--tone:${tone}${vt ? `;view-transition-name:${vt}` : ''}`;
    return `<div class="ph ${cls}${img ? ' ph--has-img' : ''}${img && fit ? ' ph--fit' : ''}" style="${style}">${img}<span class="ph__label">${label}</span></div>`;
  }

  const hasFavicon = await exists(join(ROOT, 'assets', 'favicon.svg'));
  const commonHead = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="theme-color" content="#FAF8F4">`,
    hasFavicon && `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    hasFavicon && `<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">`,
    hasFavicon && `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
    `<link rel="stylesheet" href="/fonts.css?v=${V.fonts}">`,
    `<link rel="stylesheet" href="/styles.css?v=${V.css}">`
  ].filter(Boolean).join('\n');

  // ---------- Страницы на одном языке ----------
  function renderer(lang) {
    const t = T[lang];
    const other = lang === 'ru' ? 'en' : 'ru';
    const tx = key => esc(t[key]);
    const loc = obj => esc(obj?.[lang] ?? '');
    const href = p => `/${lang}/${p}`;
    const price = a => !hasPrice(a) ? t.priceOnRequest : lang === 'ru' ? rub(a.price) : usd(usdOf(a));
    const msg = (key, a) => t[key === 'msgBuy' && a && !hasPrice(a) ? 'msgBuyNoPrice' : key].replace('{title}', a ? a.title[lang] : '').replace('{price}', a ? price(a) : '');
    const msgAttr = (key, a) => `data-msg="${esc(msg(key, a))}"`;
    const buyAttrs = a => `data-buy data-slug="${a.slug}" data-title="${esc(a.title[lang])}" data-price="${esc(price(a))}" ${msgAttr('msgBuy', a)}`;
    const size = a => hasSize(a) ? `${a.w} × ${a.h} cm${a.framed ? ', ' + t.framed : ''}` : (a.framed ? t.framedCap : '');

    function head({ title, desc, path, image, product }) {
      const url = absUrl(`${lang}/${path}`);
      const alt = l => absUrl(`${l}/${path}`);
      return [
        commonHead,
        `<title>${esc(title)}</title>`,
        `<meta name="description" content="${esc(desc)}">`,
        `<link rel="canonical" href="${url}">`,
        ...LANGS.map(l => `<link rel="alternate" hreflang="${l}" href="${alt(l)}">`),
        `<link rel="alternate" hreflang="x-default" href="${path ? alt('en') : absUrl('')}">`,
        `<meta property="og:site_name" content="${BRAND}">`,
        `<meta property="og:locale" content="${LOCALE[lang]}">`,
        `<meta property="og:locale:alternate" content="${LOCALE[other]}">`,
        `<meta property="og:title" content="${esc(title)}">`,
        `<meta property="og:description" content="${esc(desc)}">`,
        `<meta property="og:type" content="${product ? 'product' : 'website'}">`,
        `<meta property="og:url" content="${url}">`,
        image && `<meta property="og:image" content="${esc(image)}">`,
        `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
        product && hasPrice(product) && `<meta property="product:price:amount" content="${lang === 'ru' ? product.price : usdOf(product)}">`,
        product && hasPrice(product) && `<meta property="product:price:currency" content="${lang === 'ru' ? 'RUB' : 'USD'}">`,
        product && `<meta property="og:availability" content="${isSold(product) ? 'out of stock' : 'instock'}">`,
        product && `<script type="application/ld+json">${json({
          '@context': 'https://schema.org',
          '@type': ['Product', 'VisualArtwork'],
          name: product.title[lang],
          description: product.desc[lang] || t.origLine,
          ...(image && { image }),
          url,
          brand: { '@type': 'Brand', name: BRAND },
          creator: { '@type': 'Person', name: lang === 'ru' ? 'Татьяна' : 'Tanya' },
          artform: lang === 'ru' ? 'Текстильная картина' : 'Textile art',
          artMedium: lang === 'ru' ? 'Ткань' : 'Fabric',
          ...(hasSize(product) && {
            width: { '@type': 'Distance', name: `${product.w} cm` },
            height: { '@type': 'Distance', name: `${product.h} cm` }
          }),
          // Предложение с ценой — только когда цена указана (без цены разметка Offer недействительна)
          ...(hasPrice(product) && {
            offers: {
              '@type': 'Offer',
              price: lang === 'ru' ? product.price : usdOf(product),
              priceCurrency: lang === 'ru' ? 'RUB' : 'USD',
              availability: isSold(product) ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
              url
            }
          })
        })}</script>`,
        `<script>document.documentElement.classList.add('js')</script>`
      ].filter(Boolean).join('\n');
    }

    const SECTION_IDS = ['home', 'available', 'custom', 'about', 'delivery'];

    function header(path) {
      const links = SECTION_IDS.map((id, i) => `<a href="${href('#' + id)}">${esc(t.nav[i])}</a>`).join('');
      const langLink = l => l === lang
        ? `<span aria-current="true">${l.toUpperCase()}</span>`
        : `<a href="/${l}/${path}" hreflang="${l}" lang="${l}" data-lang-link="${l}" title="${esc(T[l].langName)}">${l.toUpperCase()}</a>`;
      return `<header class="header">
  <div class="wrap header__bar">
    <a class="logo" href="${href('')}">${BRAND}</a>
    <div class="header__right">
      <nav class="nav">${links}</nav>
      <div class="lang">${langLink('ru')}<span>/</span>${langLink('en')}</div>
      <button type="button" class="burger" aria-expanded="false" aria-controls="mnav" aria-label="${tx('menu')}"><span></span><span></span></button>
    </div>
  </div>
  <nav class="mnav" id="mnav" hidden>${links}</nav>
</header>`;
    }

    function footer() {
      return `<footer class="footer">
  <div class="wrap footer__inner">
    <span>${BRAND} · ${tx('footerTag')} · © ${new Date().getFullYear()} Tanya</span>
    <div class="footer__links">
      <a href="${C.ig}" target="_blank" rel="noopener">Instagram</a>
      <a href="${C.tg}" target="_blank" rel="noopener">Telegram</a>
      <a href="${esc(C.pinterest)}" target="_blank" rel="noopener">Pinterest</a>
      <a href="${href('#contact')}">${tx('contactLink')}</a>
      <a href="${href('privacy/')}">${tx('privacyLink')}</a>
    </div>
  </div>
</footer>`;
    }

    function contactButton(kind, extra = '', attrs = '') {
      const tg = kind === 'telegram';
      return `<a class="cbtn cbtn--${tg ? 'tg' : 'ig'}" href="${tg ? C.tg : C.ig}" target="_blank" rel="noopener"${attrs}>
  <span class="cbtn__txt"><span class="cbtn__name">${tg ? 'Telegram' : 'Instagram'}</span><span class="cbtn__handle">${tg ? C.tgHandle : C.igHandle}${extra}</span></span><span class="cbtn__arrow" aria-hidden="true">→</span>
</a>`;
    }

    // Окно покупки, уведомление «скопировано» и баннер cookies (если подключена Метрика)
    function overlays() {
      return `<div class="sheet" id="sheet" hidden>
  <div class="sheet__box" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="sheet__head">
      <div>
        <span class="sheet__sub"></span>
        <h3 id="sheet-title">${tx('sheetTitle')}</h3>
      </div>
      <button type="button" class="sheet__close" aria-label="${tx('close')}">×</button>
    </div>
    <div class="sheet__msg">
      <div class="sheet__msg-label">${tx('msgLabel')}<button type="button" class="sheet__copy">${tx('copyBtn')}</button></div>
      <p class="sheet__msg-text"></p>
    </div>
    ${contactButton('telegram', ' · ' + tx('recommended'), ' data-sheet-msg')}
    ${contactButton('instagram', '', ' data-sheet-msg')}
    <p class="caption">${tx('copyHint')}</p>
  </div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="8.25" stroke="#FAF8F4" stroke-opacity=".5" stroke-width="1.5"/><path d="M5.5 9.2l2.3 2.3 4.7-4.9" stroke="#FAF8F4" stroke-width="1.6" stroke-linecap="square"/></svg><span>${tx('copied')}</span></div>${YM ? `
<div class="consent" id="consent" role="region" aria-label="Cookies" hidden>
  <p>${tx('consentText')} <a href="${href('privacy/')}">${tx('consentMore')}</a></p>
  <div class="consent__btns">
    <button type="button" class="btn btn--sm btn--outline" data-consent="no">${tx('consentDecline')}</button>
    <button type="button" class="btn btn--sm" data-consent="yes">${tx('consentAccept')}</button>
  </div>
</div>` : ''}`;
    }

    function page({ headHtml, path, body, bodyClass = '' }) {
      return `<!DOCTYPE html>
<html lang="${lang}"${YM ? ` data-ym="${YM}"` : ''}>
<head>
${headHtml}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${header(path)}
${body}
${footer()}
${overlays()}
<script src="/app.js?v=${V.js}"></script>
</body>
</html>
`;
    }

    // ---------- Карточка работы ----------
    function card(a, i) {
      const sold = isSold(a);
      const action = sold
        ? `<a class="similar" href="${C.tg}" target="_blank" rel="noopener" ${msgAttr('msgSimilar', a)} data-slug="${a.slug}">${tx('orderSimilar')}</a>`
        : `<button type="button" class="btn btn--sm" ${buyAttrs(a)}>${tx('buyInquire')}</button>`;
      return `<article class="card reveal${sold ? ' is-sold' : ''}" data-cats="${a.cats.join(' ')}" style="--d:${(i % 3) * 90}ms">
  ${ph({ photo: a.photos[0], tone: a.tone, label: 'photo · ' + a.slug, cls: 'card__img', alt: a.title[lang], sizes: SIZES.card, vt: 'art-' + a.slug, fit: true })}
  <div class="card__info">
    <div class="card__row">
      <h3><a class="card__link" href="${href(`art/${a.slug}/`)}">${loc(a.title)}</a></h3>
      <span class="badge">${tx(statusKey(a))}</span>
    </div>
    <p class="card__meta">${tx('origLine')}</p>
    ${size(a) ? `<p class="card__meta">${esc(size(a))}</p>` : ''}
  </div>
  <div class="card__foot">
    <span class="card__price">${forSale(a) ? price(a) : ''}</span>
    ${action}
  </div>
</article>`;
    }

    // ---------- Главная ----------
    function homePage() {
      const chips = CATS.map((c, i) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="${i === 0}">${esc(t.cats[c])}</button>`).join('\n      ');
      const kinds = CUSTOM_TONES.map((tone, i) => `<figure class="reveal" style="--d:${i * 70}ms">
          ${ph({ photo: settings.customPhotos?.[i], tone, alt: t.kinds[i], sizes: SIZES.kind, fit: true })}
          <figcaption>${esc(t.kinds[i])}</figcaption>
        </figure>`).join('\n        ');

      const body = `<main>
  <section id="home" class="wrap hero${IMG.has(settings.heroPhoto) ? ' hero--photo' : ''}">
    ${ph({ photo: settings.heroPhoto, tone: '#D9D2C4', label: 'hero · best artwork photo', cls: 'hero__img', alt: t.heroTitle, sizes: SIZES.hero, eager: true, natural: true })}
    <div class="hero__text">
      <h1>${tx('heroTitle')}</h1>
      <p class="hero__lead">${tx('heroText')}</p>
      <div><a class="btn" href="#available">${tx('heroBtn')}</a></div>
    </div>
  </section>

  <section id="available" class="wrap available">
    <div class="sec-head reveal">
      <h2 class="h2">${tx('availTitle')}</h2>
      <p class="lead">${tx('availSub')}</p>
    </div>
    <div class="chips" role="group">
      ${chips}
    </div>
    <div class="grid" id="cards">
      ${artworks.map(card).join('\n      ')}
    </div>
    <p class="empty" id="empty" hidden>${tx('empty')}</p>
    <p class="ship-note">${tx('shipNote')}</p>
  </section>

  <section id="custom" class="custom">
    <div class="wrap custom__inner">
      <div class="custom__head reveal">
        <h2 class="h2">${tx('customTitle')}</h2>
        <p class="body-text">${tx('customText')}</p>
        <div><a class="btn" href="${C.tg}" target="_blank" rel="noopener" ${msgAttr('msgCustom')}>${tx('customBtn')}</a></div>
      </div>
      <div class="kinds">
        ${kinds}
      </div>
    </div>
  </section>

  <section id="about" class="wrap about">
    <div class="two-cols">
      ${ph({ photo: settings.aboutPhoto, tone: '#CFC6B6', label: 'photo · artist at work', cls: 'about__img reveal', alt: t.signature, sizes: SIZES.about })}
      <div class="about__text reveal" style="--d:120ms">
        <h2 class="h2">${tx('aboutTitle')}</h2>
        <p class="body-text">${tx('aboutText')}</p>
        <p class="signature">— ${tx('signature')}</p>
      </div>
    </div>
  </section>

  <section id="delivery" class="delivery">
    <div class="wrap delivery__inner">
      <div class="stack reveal">
        <h2 class="h2--sm">${tx('shipTitle')}</h2>
        <p class="body-text pretty">${tx('shipText')}</p>
      </div>
      <div class="stack reveal" id="contact" style="--d:120ms">
        <h2 class="h2--sm">${tx('contactTitle')}</h2>
        <p class="body-text pretty">${tx('contactText')}</p>
        <div class="contact-btns">
          ${contactButton('telegram')}
          ${contactButton('instagram')}
        </div>
      </div>
    </div>
  </section>
</main>`;

      return page({ path: '', body, headHtml: head({ title: t.homeTitle, desc: t.metaDesc, path: '', image: ogImage(cover) }) });
    }

    // ---------- Страница картины ----------
    function artPage(a) {
      const sold = isSold(a);
      const label = i => esc(t.photos[i] ?? `${i + 1}`);
      const photos = a.photos.filter(p => IMG.has(p));
      // Без фото — 4 заглушки (работа, фактура, интерьер, рама). С одним фото миниатюры не нужны.
      const slots = photos.length ? photos : [null, null, null, null];
      const thumbs = slots.length < 2 ? '' : `<div class="thumbs">
        ${slots.map((p, i) => {
          const info = p && IMG.get(p);
          const data = info ? ` data-w="${info.width}" data-h="${info.height}" data-srcset="${info.widths.map(w => `/img/${info.base}-${w}.webp ${w}w`).join(', ')}" data-src="/img/${info.base}-${info.widths.find(w => w >= 800) ?? info.widths[info.widths.length - 1]}.webp"` : '';
          return `<button type="button" class="thumb" style="--tone:${a.tone}" aria-pressed="${i === 0}" aria-label="${label(i)}"${data}>${p ? pic(p, { sizes: SIZES.thumb }) : ''}<span class="ph__label">${label(i)}</span></button>`;
        }).join('\n        ')}
      </div>`;

      const specs = [
        hasSize(a) && [tx('sSize'), esc(`${t.approx} ${a.w} × ${a.h} cm`), ''],
        [tx('sFrame'), tx(a.framed ? 'included' : 'notIncluded'), ''],
        forSale(a) && [tx('sPrice'), esc(price(a)), ''],
        [tx('sStatus'), tx(statusKey(a)), sold ? 'st-sold' : 'st-available']
      ].filter(Boolean).map(([k, v, cls]) => `<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('\n        ');

      const action = sold
        ? `<a class="btn btn--lg" href="${C.tg}" target="_blank" rel="noopener" ${msgAttr('msgSimilar', a)} data-slug="${a.slug}">${tx('orderSimilar')}</a>`
        : `<button type="button" class="btn btn--lg" ${buyAttrs(a)}>${tx('buy')}</button>`;

      const others = artworks.filter(o => o.slug !== a.slug)
        .sort((x, y) => isSold(x) - isSold(y))
        .slice(0, 3)
        .map((o, i) => `<article class="other reveal${isSold(o) ? ' is-sold' : ''}" style="--d:${i * 90}ms">
        ${ph({ photo: o.photos[0], tone: o.tone, cls: 'other__img', alt: o.title[lang], sizes: SIZES.card, vt: 'art-' + o.slug, fit: true })}
        <div class="card__row">
          <h3><a class="card__link" href="${href(`art/${o.slug}/`)}">${loc(o.title)}</a></h3>
          <span class="other__price">${forSale(o) ? price(o) : ''}</span>
        </div>
      </article>`).join('\n      ');

      const sticky = sold ? '' : `<div class="sticky-buy">
  <div class="sticky-buy__txt">
    <span class="sticky-buy__title">${loc(a.title)}</span>
    <span class="sticky-buy__price">${price(a)}</span>
  </div>
  <button type="button" class="btn" ${buyAttrs(a)}>${tx('buy')}</button>
</div>`;

      const body = `<main class="wrap art">
  <a class="back" href="${href('#available')}">${tx('back')}</a>
  <div class="art__grid">
    <div class="gallery">
      ${ph({ photo: slots[0], tone: a.tone, label: 'photo · ' + label(0), cls: 'gallery__main', alt: a.title[lang], sizes: SIZES.main, eager: true, vt: 'art-' + a.slug, natural: true })}
      ${thumbs}
    </div>

    <div class="art__info">
      <div class="art__titles">
        <h1>${loc(a.title)}</h1>
        <p class="art__orig">${tx('origLine')}</p>
        <p class="art__tech">${tx('techLine')}</p>
      </div>
      <dl class="specs">
        ${specs}
      </dl>
      <div class="buy-box">
        ${action}
        <p class="caption">${tx('buyCaption')}</p>
        <a class="ask" href="${C.tg}" target="_blank" rel="noopener" ${msgAttr('msgShipping', a)} data-slug="${a.slug}">${tx('askShipping')}</a>
      </div>
      <p class="plate">${tx('shipPlate')}</p>
    </div>
  </div>

  <section class="art-sec art-sec--about reveal">
    <h2 class="h2--art">${tx('aboutArt')}</h2>
    <p class="body-text">${loc(a.desc)}</p>
  </section>

  <section class="art-sec">
    <h2 class="h2--art reveal">${tx('otherWorks')}</h2>
    <div class="grid grid--others">
      ${others}
    </div>
  </section>

  <section class="banner reveal">
    <h2>${tx('bannerTitle')}</h2>
    <a class="btn" href="${href('#custom')}">${tx('bannerBtn')}</a>
  </section>
</main>
${sticky}`;

      return page({
        path: `art/${a.slug}/`,
        bodyClass: sold ? '' : 'has-sticky',
        body,
        headHtml: head({
          title: `${a.title[lang]} — ${BRAND}`,
          desc: [t.origLine + (hasSize(a) ? `, ${a.w} × ${a.h} cm` : ''), hasPrice(a) ? price(a) : '', a.desc[lang] || ''].filter(Boolean).join('. ').trim(),
          path: `art/${a.slug}/`,
          image: ogImage(a.photos[0]),
          product: a
        })
      });
    }

    // ---------- Политика конфиденциальности ----------
    function privacyPage() {
      const owner = esc(settings.ownerName || t.privacyOwnerDefault);
      const email = String(settings.ownerEmail || '').trim();
      const contact = email
        ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
        : `<a href="${C.tg}" target="_blank" rel="noopener">Telegram ${C.tgHandle}</a>`;
      const fill = s => esc(s).replace('{site}', esc(new URL(SITE_URL).host)).replace('{owner}', owner).replace(/\{contact\}/g, contact);
      const body = `<main class="wrap legal">
  <h1>${tx('privacyTitle')}</h1>
  <p class="legal__date">${tx('privacyUpdated')}</p>
  ${t.privacy.map(([h, p]) => `<section><h2>${esc(h)}</h2><p>${fill(p)}</p></section>`).join('\n  ')}
  ${YM ? `<p><button type="button" class="btn btn--outline" data-consent-reset>${tx('consentReset')}</button></p>
  <p class="legal__note" id="consent-reset-done" hidden>${tx('consentResetDone')}</p>` : ''}
</main>`;
      return page({ path: 'privacy/', body, headHtml: head({ title: `${t.privacyTitle} — ${BRAND}`, desc: t.privacyTitle, path: 'privacy/' }) });
    }

    return { homePage, artPage, privacyPage };
  }

  // ---------- 404 (одна на все адреса: язык выбирает скрипт по адресу или по браузеру) ----------
  function notFoundPage() {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
${commonHead}
<title>404 — ${BRAND}</title>
<meta name="robots" content="noindex">
<script>document.documentElement.classList.add('js');${LANG_PICK}var m=location.pathname.match(/^\\/(ru|en)\\//);document.documentElement.lang=m?m[1]:l</script>
</head>
<body>
<header class="header">
  <div class="wrap header__bar">
    <a class="logo" href="/">${BRAND}</a>
    <div class="header__right">
      <div class="lang"><button type="button" data-set-lang="ru">RU</button><span>/</span><button type="button" data-set-lang="en">EN</button></div>
    </div>
  </div>
</header>
<main class="wrap nf">
  <p class="nf__eyebrow">${tl('nfEyebrow')}</p>
  <h1>${tl('nfTitle')}</h1>
  <p class="nf__text">${tl('nfText')}</p>
  <div class="nf__actions">
    <a class="btn" data-l="ru" href="/ru/#available">${esc(T.ru.nfBtn)}</a><a class="btn" data-l="en" href="/en/#available">${esc(T.en.nfBtn)}</a>
    <a class="btn btn--outline" href="${C.tg}" target="_blank" rel="noopener">${tl('nfTg')}</a>
  </div>
  <p class="nf__note">${tl('nfNote')}</p>
</main>
<footer class="footer">
  <div class="wrap footer__inner">
    <span>${BRAND} · ${tl('footerTag')}</span>
    <div class="footer__links">
      <a href="${C.ig}" target="_blank" rel="noopener">Instagram</a>
      <a href="${C.tg}" target="_blank" rel="noopener">Telegram</a>
      <a href="${esc(C.pinterest)}" target="_blank" rel="noopener">Pinterest</a>
    </div>
  </div>
</footer>
<script src="/app.js?v=${V.js}"></script>
</body>
</html>
`;
  }

  // ---------- Перенаправление на нужный язык (корень сайта и старые адреса без /ru/ или /en/) ----------
  function langRedirect(path, { title, desc, image } = {}) {
    const target = l => `/${l}/${path}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
${commonHead}
<title>${esc(title || BRAND)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
${path ? `<meta name="robots" content="noindex">` : ''}
${LANGS.map(l => `<link rel="alternate" hreflang="${l}" href="${absUrl(target(l))}">`).join('\n')}
<link rel="alternate" hreflang="x-default" href="${absUrl(path ? 'en/' + path : '')}">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${esc(title || BRAND)}">
${desc ? `<meta property="og:description" content="${esc(desc)}">` : ''}
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<script>${LANG_PICK}location.replace('/'+l+'/${path}'+location.search+location.hash)</script>
</head>
<body>
<main class="wrap nf">
  <p class="nf__eyebrow">${BRAND}</p>
  <div class="nf__actions">
    <a class="btn" href="${target('en')}" hreflang="en">English →</a>
    <a class="btn btn--outline" href="${target('ru')}" hreflang="ru">Русский →</a>
  </div>
</main>
</body>
</html>
`;
  }

  // ---------- Запись файлов ----------
  const out = async (path, html) => {
    const dir = join(DIST, path);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), html);
  };
  for (const lang of LANGS) {
    const r = renderer(lang);
    await out(lang, r.homePage());
    await out(`${lang}/privacy`, r.privacyPage());
    for (const a of artworks) await out(`${lang}/art/${a.slug}`, r.artPage(a));
  }
  await writeFile(join(DIST, 'index.html'), langRedirect('', { title: T.en.homeTitle, desc: T.en.metaDesc, image: ogImage(cover) }));
  for (const a of artworks) await out(`art/${a.slug}`, langRedirect(`art/${a.slug}/`, { title: `${a.title.en} — ${BRAND}` }));
  await writeFile(join(DIST, '404.html'), notFoundPage());
  await copyFile(join(ROOT, 'src', 'styles.css'), join(DIST, 'styles.css'));
  await copyFile(join(ROOT, 'src', 'app.js'), join(DIST, 'app.js'));

  if (hasFavicon) await buildFavicons(join(ROOT, 'assets', 'favicon.svg'), DIST);

  // Админка + её настройки
  await cp(join(ROOT, 'admin'), join(DIST, 'admin'), { recursive: true });
  const adminVer = (await hash(join(ROOT, 'admin', 'admin.js'), join(ROOT, 'admin', 'admin.css'))) + Date.now().toString(36).slice(-4);
  const adminHtml = join(DIST, 'admin', 'index.html');
  await writeFile(adminHtml, (await readFile(adminHtml, 'utf8')).replace(/(admin\.css|admin\.js|config\.js)"/g, '$1?v=' + adminVer + '"'));
  await writeFile(join(DIST, 'admin', 'config.js'), `window.ZOSYA = ${JSON.stringify({
    repo: GITHUB_REPO, branch: GITHUB_BRANCH, siteUrl: SITE_URL,
    cats: CATS.filter(c => c !== 'all').map(c => ({ key: c, label: T.ru.cats[c] })),
    kinds: T.ru.kinds, tones: TONES
  }, null, 2)};\n`);

  // Для GitHub Pages и поисковиков: карта сайта со связями между языковыми версиями
  await writeFile(join(DIST, 'CNAME'), new URL(SITE_URL).host + '\n');
  await writeFile(join(DIST, '.nojekyll'), '');
  const paths = ['', 'privacy/', ...artworks.map(a => `art/${a.slug}/`)];
  const urls = paths.flatMap(p => LANGS.map(lang => `  <url>
    <loc>${esc(absUrl(`${lang}/${p}`))}</loc>
${LANGS.map(l => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(absUrl(`${l}/${p}`))}"/>`).join('\n')}
  </url>`)).join('\n');
  await writeFile(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`);
  await writeFile(join(DIST, 'robots.txt'), `User-agent: *\nDisallow: /admin/\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  log(`Готово: ${LANGS.length} языка × (главная, политика, ${artworks.length} картин), ${IMG.size} фото${YM ? ', Метрика ' + YM : ''}`);
  return { artworks: artworks.length, photos: IMG.size };
}

// Шрифты из пакетов @fontsource: только кириллица и латиница нужных начертаний → dist/fonts + dist/fonts.css
async function buildFonts(dist) {
  const want = { 'cormorant-garamond': ['500', '600', '500-italic'], manrope: ['400', '500', '600'] };
  await mkdir(join(dist, 'fonts'), { recursive: true });
  let css = '';
  for (const [pkg, files] of Object.entries(want)) {
    const dir = join(ROOT, 'node_modules', '@fontsource', pkg);
    for (const f of files) {
      const src = await readFile(join(dir, f + '.css'), 'utf8');
      for (const [, name, body] of src.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)) {
        if (!/-(cyrillic|latin)-\d/.test(name)) continue; // без -ext, греческого, вьетнамского
        const file = `${name}.woff2`;
        await copyFile(join(dir, 'files', file), join(dist, 'fonts', file));
        css += body.replace(/src:[^;]+;/, `src: url(/fonts/${file}) format('woff2');`) + '\n';
      }
    }
  }
  await writeFile(join(dist, 'fonts.css'), css);
  return createHash('sha1').update(css).digest('hex').slice(0, 8);
}

// favicon.svg → PNG 32 и 180 (apple-touch-icon) + favicon.ico для старых браузеров и краулеров
async function buildFavicons(svgPath, dist) {
  const svg = await readFile(svgPath);
  await copyFile(svgPath, join(dist, 'favicon.svg'));
  const p32 = await sharp(svg, { density: 384 }).resize(32, 32).png().toBuffer();
  // У apple-touch-icon прозрачность не поддерживается — подкладываем молочный фон
  const p180 = await sharp(svg, { density: 384 }).resize(180, 180).flatten({ background: '#FAF8F4' }).png().toBuffer();
  await writeFile(join(dist, 'favicon-32.png'), p32);
  await writeFile(join(dist, 'apple-touch-icon.png'), p180);
  // ICO с одним PNG внутри: заголовок 6 байт + запись 16 байт + данные
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  ico.writeUInt8(32, 6); ico.writeUInt8(32, 7); ico.writeUInt8(0, 8); ico.writeUInt8(0, 9);
  ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(p32.length, 14); ico.writeUInt32LE(22, 18);
  await writeFile(join(dist, 'favicon.ico'), Buffer.concat([ico, p32]));
}
