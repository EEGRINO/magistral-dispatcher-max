import { createRoot } from 'react-dom/client';
import { MaxUI } from '@maxhub/max-ui';
import '@maxhub/max-ui/dist/styles.css';
import './app.css';
import { App } from './App';
import { LaunchDebug, isDebugLaunch } from './components/LaunchDebug';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Не найден элемент #root — проверь index.html');
}

// MaxUI — провайдер библиотеки: определяет платформу и тему.
// resetBody убирает поля у body, className нужен, чтобы покрасить фон:
// переменные темы живут на этом же элементе.
createRoot(container).render(
  <MaxUI resetBody className="app-root">
    {/* ВРЕМЕННО: ?debug — экран проверки запуска, см. LaunchDebug. */}
    {isDebugLaunch() ? (
      <LaunchDebug>
        <App />
      </LaunchDebug>
    ) : (
      <App />
    )}
  </MaxUI>,
);
