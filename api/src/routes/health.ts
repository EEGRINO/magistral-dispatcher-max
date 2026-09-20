/**
 * GET /health — живость сервиса И соединения с БД.
 *
 * Проверять только «процесс жив» бессмысленно: на этот эндпоинт завязан
 * healthcheck в docker-compose, а от него — порядок запуска бота.
 * Поэтому при недоступной БД отвечаем 503, а не 200.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { pool } from '../db.js';
import { HealthResponse } from '../schemas.js';

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        description: 'Живость сервиса и соединения с БД',
        response: {
          200: HealthResponse,
          503: HealthResponse,
        },
      },
    },
    async (_request, reply) => {
      const ts = new Date().toISOString();

      try {
        await pool.query('SELECT 1');
        return { status: 'ok' as const, service: 'api' as const, db: 'ok' as const, ts };
      } catch (error) {
        app.log.error({ err: error }, 'health: БД недоступна');

        return reply.code(503).send({
          status: 'degraded' as const,
          service: 'api' as const,
          db: 'down' as const,
          ts,
        });
      }
    },
  );
};
