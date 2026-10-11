// Настройки, которые меняет разработчик. Работы, цены, фото и контакты
// редактируются в админке (/admin/) и лежат в папке content/.

// Основной адрес сайта без слеша на конце.
export const SITE_URL = 'https://zosyahandmade.ru';

// Репозиторий GitHub, куда админка сохраняет изменения: 'имя-пользователя/zosyahandmade'.
// Если пусто — админка работает только локально (npm run dev).
export const GITHUB_REPO = 'MrRadrigos/zosyahandmade';
export const GITHUB_BRANCH = 'main';

// Категории для фильтра. Названия — в data/i18n.mjs (cats).
export const CATS = ['all', 'animals', 'portraits', 'landscapes', 'interior', 'kids', 'names', 'masterpieces'];

// Цвета заглушек для работ без фото и для примеров «На заказ».
export const TONES = ['#B9C4C6', '#D4B79A', '#AEB6C8', '#A9BDB4', '#DCCB96', '#E1C7C2', '#C9B9A6', '#B8BFC9', '#B4C2B2', '#D2C6B0'];
export const CUSTOM_TONES = ['#C9B9A6', '#B8BFC9', '#B4C2B2', '#D2C6B0', '#E0CCC4'];
