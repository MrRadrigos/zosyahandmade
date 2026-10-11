// Сборка сайта: node build.mjs → папка dist/
import { build } from './lib/build.mjs';

try {
  await build();
} catch (e) {
  console.error('Ошибка сборки: ' + e.message);
  process.exit(1);
}
