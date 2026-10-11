// Сборка статического сайта в папку dist/.
// Главная — dist/index.html, у каждой картины своя страница dist/art/<slug>/index.html.
// Данные берутся из content/*.json (их редактирует админка), тексты — из data/i18n.mjs.
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
const nb = s => s.replace(/[\s\u00a0\u202f,]/g, '\u00a0');
const rub = n => nb(Math.round(n).toLocaleString('ru-RU')) + '\u00a0₽';
const usd = n => '$' + Math.round(n).toLocaleString('en-US');
const roundUsd = x => x < 100 ? Math.max(5, Math.round(x / 5) * 5) : Math.round(x / 10) * 10;

// Текст на двух языках: показывается только span текущего языка (см. styles.css)
const L = (ru, en) => ru === en ? esc(ru) : `<span data-l="ru">${esc(ru)}</span><span data-l="en">${esc(en)}</span>`;
const tl = key => L(T.ru[key], T.en[key]);
const lo = obj => L(obj.ru, obj.en);

const handle = s => String(s || '').trim().replace(/^https?:\/\/(www\.)?[^/]+\//, '').replace(/^@/, '').replace(/[/?#].*$/, '');
const absUrl = path => SITE_URL + '/' + path.replace(/^\//, '');
const isSold = a => a.status === 'sold';

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
    if (!(a.price > 0)) throw new Error(`${name}: не указана цена`);
    if (!(a.w > 0 && a.h > 0)) throw new Error(`${name}: не указан размер`);
    for (const c of a.cats || []) if (!CATS.includes(c)) throw new Error(`${name}: неизвестная категория «${c}»`);
    if (!['available', 'sold'].includes(a.status)) throw new Error(`${name}: статус должен быть available или sold`);
  });
  if (!(settings.usdRate > 0)) throw new Error('Настройки: не указан курс доллара');
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
  const usdOf = a => a.priceUsd > 0 ? a.priceUsd : roundUsd(a.price / settings.usdRate);
  const priceL = a => L(rub(a.price), usd(usdOf(a)));
  const priceIn = (a, lang) => lang === 'ru' ? rub(a.price) : usd(usdOf(a));
  const msg = (lang, key, a) => T[lang][key].replace('{title}', a?.title[lang] ?? '').replace('{price}', a ? priceIn(a, lang) : '');
  const msgAttrs = (key, a) => `data-msg-ru="${esc(msg('ru', key, a))}" data-msg-en="${esc(msg('en', key, a))}"`;
  const buyAttrs = a => `data-buy data-title-ru="${esc(a.title.ru)}" data-title-en="${esc(a.title.en)}" data-price-ru="${esc(rub(a.price))}" data-price-en="${esc(usd(usdOf(a)))}" ${msgAttrs('msgBuy', a)}`;

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Фото: все размеры готовим заранее, дальше шаблоны берут их из карты IMG
  const allPhotos = [
    ...artworks.flatMap(a => a.photos),
    settings.heroPhoto, settings.aboutPhoto, ...(settings.customPhotos || [])
  ];
  const IMG = await processImages(allPhotos, { root: ROOT, dist: DIST });

  // natural: не растягивать фото больше его настоящего размера (для фото, показанных целиком)
  function pic(photo, { sizes, alt = '', eager = false, natural = false }, root) {
    const info = IMG.get(photo);
    if (!info) return '';
    const srcset = info.widths.map(w => `${root}img/${info.base}-${w}.webp ${w}w`).join(', ');
    const fallback = info.widths.find(w => w >= 800) ?? info.widths[info.widths.length - 1];
    const style = natural ? ` style="max-width:min(100%,${info.width}px)"` : '';
    return `<img src="${root}img/${info.base}-${fallback}.webp" srcset="${srcset}" sizes="${sizes}" width="${info.width}" height="${info.height}" alt="${esc(alt)}"${style}${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
  }
  const ogImage = photo => IMG.has(photo) ? absUrl(`img/${IMG.get(photo).base}-og.jpg`) : '';

  // fit: работа видна целиком (без обрезки) на светлой подложке; иначе фото заполняет блок
  function ph({ photo, tone, label = '', cls = '', alt = '', sizes = '100vw', eager = false, vt = '', fit = false, natural = false }, root) {
    const img = photo ? pic(photo, { sizes, alt, eager, natural }, root) : '';
    const style = `--tone:${tone}${vt ? `;view-transition-name:${vt}` : ''}`;
    return `<div class="ph ${cls}${img ? ' ph--has-img' : ''}${img && fit ? ' ph--fit' : ''}" style="${style}">${img}<span class="ph__label">${label}</span></div>`;
  }

  // ---------- Общие части страницы ----------
  const hasFavicon = await exists(join(ROOT, 'assets', 'favicon.svg'));

  function head({ title, desc, path, root, image, product }) {
    const url = path == null ? '' : absUrl(path);
    const meta = [
      `<meta charset="utf-8">`,
      `<meta name="viewport" content="width=device-width, initial-scale=1">`,
      `<title>${esc(title)}</title>`,
      `<meta name="description" content="${esc(desc)}">`,
      `<meta name="theme-color" content="#FAF8F4">`,
      url && `<link rel="canonical" href="${esc(url)}">`,
      hasFavicon && `<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">`,
      hasFavicon && `<link rel="icon" href="${root}favicon-32.png" sizes="32x32" type="image/png">`,
      hasFavicon && `<link rel="apple-touch-icon" href="${root}apple-touch-icon.png">`,
      `<meta property="og:site_name" content="${BRAND}">`,
      `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(desc)}">`,
      `<meta property="og:type" content="${product ? 'product' : 'website'}">`,
      url && `<meta property="og:url" content="${esc(url)}">`,
      image && `<meta property="og:image" content="${esc(image)}">`,
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
      product && `<meta property="product:price:amount" content="${product.price}">`,
      product && `<meta property="product:price:currency" content="RUB">`,
      product && `<meta property="og:availability" content="${isSold(product) ? 'out of stock' : 'instock'}">`,
      product && `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: product.title.en,
        alternateName: product.title.ru,
        description: product.desc.en || T.en.origLine,
        ...(image && { image }),
        brand: { '@type': 'Brand', name: BRAND },
        offers: ['RUB', 'USD'].map(cur => ({
          '@type': 'Offer',
          price: cur === 'RUB' ? product.price : usdOf(product),
          priceCurrency: cur,
          availability: isSold(product) ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
          url
        }))
      }).replace(/</g, '\\u003c')}</script>`,
      // Язык: ?lang= → сохранённый выбор → язык браузера (иностранцам из Pinterest сразу английский)
      `<script>document.documentElement.classList.add('js');try{var l=new URLSearchParams(location.search).get('lang')||localStorage.getItem('zosya-lang')||(/^(ru|uk|be|kk)/i.test(navigator.language||'ru')?'ru':'en');if(l==='ru'||l==='en')document.documentElement.lang=l}catch(e){}</script>`,
      `<link rel="preconnect" href="https://fonts.googleapis.com">`,
      `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
      `<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Manrope:wght@400;500;600&display=swap" rel="stylesheet">`,
      `<link rel="stylesheet" href="${root}styles.css">`
    ];
    return meta.filter(Boolean).join('\n');
  }

  const SECTION_IDS = ['home', 'available', 'custom', 'about', 'delivery'];

  function header(root) {
    const links = SECTION_IDS.map((id, i) => `<a href="${root}#${id}">${L(T.ru.nav[i], T.en.nav[i])}</a>`).join('');
    return `<header class="header">
  <div class="wrap header__bar">
    <a class="logo" href="${root}#home">${BRAND}</a>
    <div class="header__right">
      <nav class="nav">${links}</nav>
      <div class="lang">
        <button type="button" data-set-lang="ru" aria-pressed="true">RU</button>
        <span>/</span>
        <button type="button" data-set-lang="en" aria-pressed="false">EN</button>
      </div>
      <button type="button" class="burger" aria-expanded="false" aria-controls="mnav" aria-label="${T.ru.menu}" data-aria-ru="${T.ru.menu}" data-aria-en="${T.en.menu}"><span></span><span></span></button>
    </div>
  </div>
  <nav class="mnav" id="mnav" hidden>${links}</nav>
</header>`;
  }

  function footer(root) {
    return `<footer class="footer">
  <div class="wrap footer__inner">
    <span>${BRAND} · ${tl('footerTag')} · © ${new Date().getFullYear()} Tanya</span>
    <div class="footer__links">
      <a href="${C.ig}" target="_blank" rel="noopener">Instagram</a>
      <a href="${C.tg}" target="_blank" rel="noopener">Telegram</a>
      <a href="${esc(C.pinterest)}" target="_blank" rel="noopener">Pinterest</a>
      <a href="${root}#contact">${tl('contactLink')}</a>
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

  function sheet() {
    return `<div class="sheet" id="sheet" hidden>
  <div class="sheet__box" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="sheet__head">
      <div>
        <span class="sheet__sub"></span>
        <h3 id="sheet-title">${tl('sheetTitle')}</h3>
      </div>
      <button type="button" class="sheet__close" aria-label="${T.ru.close}" data-aria-ru="${T.ru.close}" data-aria-en="${T.en.close}">×</button>
    </div>
    <div class="sheet__msg">
      <div class="sheet__msg-label">${tl('msgLabel')}<button type="button" class="sheet__copy">${tl('copyBtn')}</button></div>
      <p class="sheet__msg-text"></p>
    </div>
    ${contactButton('telegram', ' · ' + tl('recommended'), ' data-sheet-msg')}
    ${contactButton('instagram', '', ' data-sheet-msg')}
    <p class="caption">${tl('copyHint')}</p>
  </div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="8.25" stroke="#FAF8F4" stroke-opacity=".5" stroke-width="1.5"/><path d="M5.5 9.2l2.3 2.3 4.7-4.9" stroke="#FAF8F4" stroke-width="1.6" stroke-linecap="square"/></svg><span>${tl('copied')}</span></div>`;
  }

  function page({ headHtml, root, body, bodyClass = '' }) {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
${headHtml}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${header(root)}
${body}
${footer(root)}
${sheet()}
<script src="${root}app.js"></script>
</body>
</html>
`;
  }

  const sizeL = a => L(`${a.w} × ${a.h} cm${a.framed ? ', ' + T.ru.framed : ''}`, `${a.w} × ${a.h} cm${a.framed ? ', ' + T.en.framed : ''}`);

  // ---------- Карточка работы ----------
  function card(a, i, root) {
    const sold = isSold(a);
    const action = sold
      ? `<a class="similar" href="${C.tg}" target="_blank" rel="noopener" ${msgAttrs('msgSimilar', a)}>${tl('orderSimilar')}</a>`
      : `<button type="button" class="btn btn--sm" ${buyAttrs(a)}>${tl('buyInquire')}</button>`;
    return `<article class="card reveal${sold ? ' is-sold' : ''}" data-cats="${a.cats.join(' ')}" style="--d:${(i % 3) * 90}ms">
  ${ph({ photo: a.photos[0], tone: a.tone, label: 'photo · ' + a.slug, cls: 'card__img', alt: a.title.en, sizes: SIZES.card, vt: 'art-' + a.slug, fit: true }, root)}
  <div class="card__info">
    <div class="card__row">
      <h3><a class="card__link" href="${root}art/${a.slug}/">${lo(a.title)}</a></h3>
      <span class="badge">${tl(sold ? 'sold' : 'available')}</span>
    </div>
    <p class="card__meta">${tl('origLine')}</p>
    <p class="card__meta">${sizeL(a)}</p>
  </div>
  <div class="card__foot">
    <span class="card__price">${priceL(a)}</span>
    ${action}
  </div>
</article>`;
  }

  // ---------- Главная ----------
  function homePage() {
    const root = '';
    const chips = CATS.map((c, i) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="${i === 0}">${L(T.ru.cats[c], T.en.cats[c])}</button>`).join('\n      ');
    const kinds = CUSTOM_TONES.map((tone, i) => `<figure class="reveal" style="--d:${i * 70}ms">
          ${ph({ photo: settings.customPhotos?.[i], tone, alt: T.en.kinds[i], sizes: SIZES.kind, fit: true }, root)}
          <figcaption>${L(T.ru.kinds[i], T.en.kinds[i])}</figcaption>
        </figure>`).join('\n        ');

    const body = `<main>
  <section id="home" class="wrap hero">
    ${ph({ photo: settings.heroPhoto, tone: '#D9D2C4', label: 'hero · best artwork photo', cls: 'hero__img', alt: BRAND, sizes: SIZES.hero, eager: true, natural: true }, root)}
    <div class="hero__text">
      <h1>${tl('heroTitle')}</h1>
      <p class="hero__lead">${tl('heroText')}</p>
      <div><a class="btn" href="#available">${tl('heroBtn')}</a></div>
    </div>
  </section>

  <section id="available" class="wrap available">
    <div class="sec-head reveal">
      <h2 class="h2">${tl('availTitle')}</h2>
      <p class="lead">${tl('availSub')}</p>
    </div>
    <div class="chips" role="group">
      ${chips}
    </div>
    <div class="grid" id="cards">
      ${artworks.map((a, i) => card(a, i, root)).join('\n      ')}
    </div>
    <p class="empty" id="empty" hidden>${tl('empty')}</p>
    <p class="ship-note">${tl('shipNote')}</p>
  </section>

  <section id="custom" class="custom">
    <div class="wrap custom__inner">
      <div class="custom__head reveal">
        <h2 class="h2">${tl('customTitle')}</h2>
        <p class="body-text">${tl('customText')}</p>
        <div><a class="btn" href="${C.tg}" target="_blank" rel="noopener" ${msgAttrs('msgCustom')}>${tl('customBtn')}</a></div>
      </div>
      <div class="kinds">
        ${kinds}
      </div>
    </div>
  </section>

  <section id="about" class="wrap about">
    <div class="two-cols">
      ${ph({ photo: settings.aboutPhoto, tone: '#CFC6B6', label: 'photo · artist at work', cls: 'about__img reveal', alt: 'Tanya', sizes: SIZES.about }, root)}
      <div class="about__text reveal" style="--d:120ms">
        <h2 class="h2">${tl('aboutTitle')}</h2>
        <p class="body-text">${tl('aboutText')}</p>
        <p class="signature">— ${tl('signature')}</p>
      </div>
    </div>
  </section>

  <section id="delivery" class="delivery">
    <div class="wrap delivery__inner">
      <div class="stack reveal">
        <h2 class="h2--sm">${tl('shipTitle')}</h2>
        <p class="body-text pretty">${tl('shipText')}</p>
      </div>
      <div class="stack reveal" id="contact" style="--d:120ms">
        <h2 class="h2--sm">${tl('contactTitle')}</h2>
        <p class="body-text pretty">${tl('contactText')}</p>
        <div class="contact-btns">
          ${contactButton('telegram')}
          ${contactButton('instagram')}
        </div>
      </div>
    </div>
  </section>
</main>`;

    const cover = settings.heroPhoto || artworks.find(a => a.photos[0])?.photos[0];
    return page({
      root,
      headHtml: head({ title: `${BRAND} — Original Handmade Textile Art`, desc: T.en.metaDesc, path: '', root, image: ogImage(cover) }),
      body
    });
  }

  // ---------- Страница картины ----------
  function artPage(a) {
    const root = '../../';
    const sold = isSold(a);
    const label = i => L(T.ru.photos[i] ?? `${i + 1}`, T.en.photos[i] ?? `${i + 1}`);
    const photos = a.photos.filter(p => IMG.has(p));
    // Без фото — 4 заглушки (работа, фактура, интерьер, рама). С одним фото миниатюры не нужны.
    const slots = photos.length ? photos : [null, null, null, null];
    const thumbs = slots.length < 2 ? '' : `<div class="thumbs">
        ${slots.map((p, i) => {
          const info = p && IMG.get(p);
          const data = info ? ` data-w="${info.width}" data-h="${info.height}" data-srcset="${info.widths.map(w => `${root}img/${info.base}-${w}.webp ${w}w`).join(', ')}" data-src="${root}img/${info.base}-${info.widths.find(w => w >= 800) ?? info.widths[info.widths.length - 1]}.webp"` : '';
          const aria = `aria-label="${esc(T.ru.photos[i] ?? i + 1)}" data-aria-ru="${esc(T.ru.photos[i] ?? i + 1)}" data-aria-en="${esc(T.en.photos[i] ?? i + 1)}"`;
          return `<button type="button" class="thumb" style="--tone:${a.tone}" aria-pressed="${i === 0}" ${aria}${data}>${p ? pic(p, { sizes: SIZES.thumb }, root) : ''}<span class="ph__label">${label(i)}</span></button>`;
        }).join('\n        ')}
      </div>`;

    const specs = [
      [tl('sSize'), L(`${T.ru.approx} ${a.w} × ${a.h} cm`, `${T.en.approx} ${a.w} × ${a.h} cm`), ''],
      [tl('sFrame'), tl(a.framed ? 'included' : 'notIncluded'), ''],
      [tl('sPrice'), priceL(a), ''],
      [tl('sStatus'), tl(sold ? 'sold' : 'available'), sold ? 'st-sold' : 'st-available']
    ].map(([k, v, cls]) => `<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('\n        ');

    const action = sold
      ? `<a class="btn btn--lg" href="${C.tg}" target="_blank" rel="noopener" ${msgAttrs('msgSimilar', a)}>${tl('orderSimilar')}</a>`
      : `<button type="button" class="btn btn--lg" ${buyAttrs(a)}>${tl('buy')}</button>`;

    const others = artworks.filter(o => o.slug !== a.slug)
      .sort((x, y) => isSold(x) - isSold(y))
      .slice(0, 3)
      .map((o, i) => `<article class="other reveal${isSold(o) ? ' is-sold' : ''}" style="--d:${i * 90}ms">
        ${ph({ photo: o.photos[0], tone: o.tone, cls: 'other__img', alt: o.title.en, sizes: SIZES.card, vt: 'art-' + o.slug, fit: true }, root)}
        <div class="card__row">
          <h3><a class="card__link" href="${root}art/${o.slug}/">${lo(o.title)}</a></h3>
          <span class="other__price">${priceL(o)}</span>
        </div>
      </article>`).join('\n      ');

    const sticky = sold ? '' : `<div class="sticky-buy">
  <div class="sticky-buy__txt">
    <span class="sticky-buy__title">${lo(a.title)}</span>
    <span class="sticky-buy__price">${priceL(a)}</span>
  </div>
  <button type="button" class="btn" ${buyAttrs(a)}>${tl('buy')}</button>
</div>`;

    const body = `<main class="wrap art">
  <a class="back" href="${root}#available">${tl('back')}</a>
  <div class="art__grid">
    <div class="gallery">
      ${ph({ photo: slots[0], tone: a.tone, label: 'photo · ' + label(0), cls: 'gallery__main', alt: a.title.en, sizes: SIZES.main, eager: true, vt: 'art-' + a.slug, natural: true }, root)}
      ${thumbs}
    </div>

    <div class="art__info">
      <div class="art__titles">
        <h1>${lo(a.title)}</h1>
        <p class="art__orig">${tl('origLine')}</p>
        <p class="art__tech">${tl('techLine')}</p>
      </div>
      <dl class="specs">
        ${specs}
      </dl>
      <div class="buy-box">
        ${action}
        <p class="caption">${tl('buyCaption')}</p>
        <a class="ask" href="${C.tg}" target="_blank" rel="noopener" ${msgAttrs('msgShipping', a)}>${tl('askShipping')}</a>
      </div>
      <p class="plate">${tl('shipPlate')}</p>
    </div>
  </div>

  <section class="art-sec art-sec--about reveal">
    <h2 class="h2--art">${tl('aboutArt')}</h2>
    <p class="body-text">${lo(a.desc)}</p>
  </section>

  <section class="art-sec">
    <h2 class="h2--art reveal">${tl('otherWorks')}</h2>
    <div class="grid grid--others">
      ${others}
    </div>
  </section>

  <section class="banner reveal">
    <h2>${tl('bannerTitle')}</h2>
    <a class="btn" href="${root}#custom">${tl('bannerBtn')}</a>
  </section>
</main>
${sticky}`;

    return page({
      root,
      bodyClass: sold ? '' : 'has-sticky',
      headHtml: head({
        title: `${a.title.ru} / ${a.title.en} — ${BRAND}`,
        desc: `${T.en.origLine}, ${a.w} × ${a.h} cm. ${rub(a.price)} / ${usd(usdOf(a))}. ${a.desc.en}`.trim(),
        path: `art/${a.slug}/`,
        root,
        image: ogImage(a.photos[0]),
        product: a
      }),
      body
    });
  }

  // ---------- 404 ----------
  // GitHub Pages показывает её по любому несуществующему адресу, поэтому пути от корня сайта.
  function notFoundPage() {
    const root = '/';
    const body = `<main class="wrap nf">
  <p class="nf__eyebrow">${tl('nfEyebrow')}</p>
  <h1>${tl('nfTitle')}</h1>
  <p class="nf__text">${tl('nfText')}</p>
  <div class="nf__actions">
    <a class="btn" href="/#available">${tl('nfBtn')}</a>
    <a class="btn btn--outline" href="${C.tg}" target="_blank" rel="noopener">${tl('nfTg')}</a>
  </div>
  <p class="nf__note">${tl('nfNote')}</p>
</main>`;
    return page({ root, headHtml: head({ title: `404 — ${BRAND}`, desc: T.en.metaDesc, path: null, root }) + '\n<meta name="robots" content="noindex">', body });
  }

  // ---------- Запись файлов ----------
  await writeFile(join(DIST, 'index.html'), homePage());
  for (const a of artworks) {
    const dir = join(DIST, 'art', a.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), artPage(a));
  }
  await writeFile(join(DIST, '404.html'), notFoundPage());
  await copyFile(join(ROOT, 'src', 'styles.css'), join(DIST, 'styles.css'));
  await copyFile(join(ROOT, 'src', 'app.js'), join(DIST, 'app.js'));

  if (hasFavicon) await buildFavicons(join(ROOT, 'assets', 'favicon.svg'), DIST);

  // Админка + её настройки
  await cp(join(ROOT, 'admin'), join(DIST, 'admin'), { recursive: true });
  await writeFile(join(DIST, 'admin', 'config.js'), `window.ZOSYA = ${JSON.stringify({
    repo: GITHUB_REPO, branch: GITHUB_BRANCH, siteUrl: SITE_URL,
    cats: CATS.filter(c => c !== 'all').map(c => ({ key: c, label: T.ru.cats[c] })),
    kinds: T.ru.kinds, tones: TONES
  }, null, 2)};\n`);

  // Для GitHub Pages и поисковиков
  const host = new URL(SITE_URL).host;
  await writeFile(join(DIST, 'CNAME'), host + '\n');
  await writeFile(join(DIST, '.nojekyll'), '');
  const urls = ['', ...artworks.map(a => `art/${a.slug}/`)].map(p => `  <url><loc>${esc(absUrl(p))}</loc></url>`).join('\n');
  await writeFile(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  await writeFile(join(DIST, 'robots.txt'), `User-agent: *\nDisallow: /admin/\nSitemap: ${SITE_URL}/sitemap.xml\n`);

  log(`Готово: главная, ${artworks.length} страниц картин, ${IMG.size} фото`);
  return { artworks: artworks.length, photos: IMG.size };
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
