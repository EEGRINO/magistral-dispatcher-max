export interface LaunchInfo {
  platform: MaxPlatform;
  version: string;
  /** Имя жителя из аккаунта MAX; null, если клиент его не отдал. */
  userName: string | null;
}

/**
 * null — приложение открыто не внутри MAX (например, `npm run dev` в браузере).
 * Это не ошибка, а другой контекст запуска: экраны должны работать и так.
 */
export function getLaunchInfo(): LaunchInfo | null {
  const webApp = window.WebApp;

  if (!webApp) {
    return null;
  }

  return {
    platform: webApp.platform,
    version: webApp.version,
    userName: readUserName(webApp.initDataUnsafe),
  };
}

// Форму initDataUnsafe на живом клиенте ещё не проверяли, поэтому разбираем
// её через проверки: неожиданная структура даст null, а не падение приложения.
function readUserName(initData: unknown): string | null {
  if (typeof initData !== 'object' || initData === null || !('user' in initData)) {
    return null;
  }

  const user = (initData as { user: unknown }).user;

  if (typeof user !== 'object' || user === null || !('first_name' in user)) {
    return null;
  }

  const firstName = (user as { first_name: unknown }).first_name;
  return typeof firstName === 'string' ? firstName : null;
}
