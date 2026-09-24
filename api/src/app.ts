/**
 * Сборка Fastify-приложения: типизация, обработка ошибок, маршруты.
 *
 * Вынесено из index.ts отдельно, чтобы приложение можно было собрать
 * без прослушивания порта — это понадобится для тестов.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { config } from './config.js';
import { ApiError, mapPgError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { residentRoutes } from './routes/residents.js';
import { ticketRoutes } from './routes/tickets.js';
import type { Rules } from './routing.js';

export function buildApp({ rules }: { rules: Rules }): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Логи пишет обратный прокси/compose, а не клиент: доверять
    // X-Forwarded-* без прокси перед сервисом нельзя.
    trustProxy: false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Единый формат ошибок — см. errors.ts и docs/api.md.
  // Тип error аннотируем явно: withTypeProvider ломает его вывод.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Ошибки валидации TypeBox/ajv: клиенту нужно знать, какое поле не так.
    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Некорректное тело запроса',
          details: error.validation.map(
            (issue) => `${issue.instancePath || '(корень)'} ${issue.message ?? 'некорректно'}`,
          ),
        },
      });
    }

    const known = error instanceof ApiError ? error : mapPgError(error);

    if (known) {
      return reply.code(known.statusCode).send({
        error: { code: known.code, message: known.message },
      });
    }

    // Ошибки самого Fastify — битый JSON, неверный Content-Type, несовпадение
    // Content-Length — приходят со своим statusCode. Отдавать их как 500 значит
    // врать клиенту: это ошибка запроса, а не сервера, и искать её надо у себя.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.warn({ err: error }, 'некорректный запрос');

      return reply.code(error.statusCode).send({
        error: {
          // Стабильный код контракта; внутренний код Fastify — в message.
          code: 'bad_request',
          message: error.message,
        },
      });
    }

    // Всё остальное — наша вина. Наружу без подробностей, в лог целиком.
    request.log.error({ err: error }, 'необработанная ошибка');

    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Внутренняя ошибка сервиса' },
    });
  });

  // Иначе Fastify отдаёт 404 в своём формате, и у клиента два разных
  // формата ошибок вместо одного.
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'route_not_found',
        message: `Маршрут ${request.method} ${request.url} не существует`,
      },
    }),
  );

  app.register(healthRoutes);
  app.register(residentRoutes);
  app.register(ticketRoutes, { rules });
  app.register(adminRoutes);

  return app;
}
