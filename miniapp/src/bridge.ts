/**
 * Обёртки над MAX Bridge (window.WebApp). Вне MAX (браузер, `npm run dev`)
 * объекта нет — тогда обычное поведение браузера.
 */

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
