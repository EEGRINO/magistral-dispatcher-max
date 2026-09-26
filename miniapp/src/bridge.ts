/**
 * Обёртки над MAX Bridge (window.WebApp). Вне MAX (браузер, `npm run dev`)
 * объекта нет — тогда обычное поведение браузера.
 */

/** Можно ли закрыть мини-приложение кнопкой — только внутри MAX. */
export const canClose = (): boolean => typeof window.WebApp?.close === 'function';

/**
 * Закрыть мини-приложение — WebApp.close() из скрипта MAX Bridge (метода нет на
 * странице документации, но он есть в самом max-web-app.js, проверено 26.09.2026).
 */
export function closeMiniApp(): void {
  window.WebApp?.close?.();
}

/**
 * Ссылка на чат MAX. openMaxLink открывает её внутри MAX; обычная ссылка
 * ушла бы во внешний браузер (docs/max-notes.md, проверено 24.09.2026).
 */
export function openMaxLink(url: string): void {
  const webApp = window.WebApp;
  if (webApp?.openMaxLink) {
    webApp.openMaxLink(url);
    return;
  }
  window.open(url, '_blank', 'noopener');
}
