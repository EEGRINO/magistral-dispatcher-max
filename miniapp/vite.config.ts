import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Две сборки из одного кода:
//   vite build                → dist/         раздельные файлы, это едет на сервер
//   vite build --mode single  → dist-single/  всё внутри одного index.html
//
// Однофайловая нужна только чтобы открыть сборку двойным кликом: обычную
// браузер с протокола file:// не запустит — внешние ES-модули он оттуда
// грузить отказывается, и страница остаётся пустой без всякой ошибки.
export default defineConfig(({ mode }) => {
  const singleFile = mode === 'single';

  return {
    plugins: singleFile ? [react(), viteSingleFile()] : [react()],
    // Относительные пути к ассетам: статика одинаково работает и с корня
    // домена, и из подкаталога — куда nginx её ни положи.
    base: './',
    build: singleFile ? { outDir: 'dist-single' } : {},
  };
});
