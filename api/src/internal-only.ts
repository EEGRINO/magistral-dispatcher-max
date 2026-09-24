/**
 * Защита внутренних маршрутов — вторая линия после nginx, на случай если он
 * снова откроет их наружу (так уже было 24.09.2026: оба домена проксировали
 * в api всё подряд).
 *
 * nginx ставит X-Real-IP / X-Forwarded-For на КАЖДЫЙ проксируемый запрос, и
 * снаружи убрать эти заголовки нельзя. Бот и команда УК на сервере ходят в api
 * напрямую, без прокси, и их не шлют. Значит, запрос с ними пришёл из
 * интернета — отвечаем обычным «маршрута нет», как на любой несуществующий
 * путь: 403 подсказал бы, что здесь что-то охраняется.
 *
 * Намеренно не через trustProxy: он решает, верить ли адресу клиента из этих
 * заголовков, а здесь важен сам факт их наличия. trustProxy не трогаем.
 *
 * Подключается хуком onRequest внутри плагина — Fastify применяет его только
 * к маршрутам этого плагина.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export async function rejectProxied(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (request.headers['x-real-ip'] !== undefined || request.headers['x-forwarded-for'] !== undefined) {
    request.log.warn({ url: request.url }, 'внешний запрос к внутреннему маршруту — отвечаем 404');
    reply.callNotFound();
    return reply;
  }
}
