// Типы MAX Bridge. Пакета с типами не существует — Bridge подключается
// скриптом из index.html, поэтому описываем window.WebApp сами.
// Только те поля, которые реально используем; полный список — docs/max-notes.md.
export {};

declare global {
  type MaxPlatform = 'ios' | 'android' | 'desktop' | 'web';

  interface MaxWebApp {
    platform: MaxPlatform;
    version: string;
    deviceName: string;
    /** Подписанная строка для проверки на бэкенде. */
    initData?: string;
    /** Разобранные данные запуска. Форма не проверена на живом клиенте,
     *  поэтому unknown: разбираем с проверками в bridge.ts. */
    initDataUnsafe?: unknown;
  }

  interface Window {
    // Опциональный: вне MAX (обычный браузер) скрипт Bridge объект не создаёт.
    WebApp?: MaxWebApp;
  }
}
