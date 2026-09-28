/**
 * Выгрузка OpenAPI 3.1 из схем маршрутов: npm run openapi → docs/openapi.yaml.
 *
 * Руками спецификацию не пишем: схемы TypeBox — это JSON Schema, по ним Fastify
 * проверяет запросы и ответы. Выгрузка из них не может разойтись с поведением.
 * Человеческое описание с примерами и причинами — по-прежнему docs/api.md.
 *
 * БД не нужна: приложение только собирается, порт не слушается, пул pg
 * соединяется лениво — на первом запросе, которого здесь нет.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { RouteOptions } from 'fastify';
import { stringify } from 'yaml';

process.env.DATABASE_URL ??= 'postgres://openapi-export@localhost/none';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('./app.js');
const { config } = await import('./config.js');
const { pool } = await import('./db.js');
const { loadRules } = await import('./routing.js');

type Schema = Record<string, unknown>;

/**
 * `nullable: true` — диалект OpenAPI 3.0, его понимает ajv Fastify. В 3.1
 * схема — чистый JSON Schema: null — ещё один тип.
 */
function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;

  const { nullable, ...rest } = node as Schema;
  const out = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, toJsonSchema(value)])) as Schema;
  if (nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else if (Array.isArray(out.anyOf)) out.anyOf = [...out.anyOf, { type: 'null' }];
  }
  return out;
}

/** Символьные ключи TypeBox (Kind и т.п.) JSON не переживают — они и не нужны. */
const plain = (schema: unknown): Schema => toJsonSchema(JSON.parse(JSON.stringify(schema))) as Schema;

/** POST /residents/{id}/house-by-invite → postResidentsIdHouseByInvite */
const operationId = (method: string, path: string): string =>
  method.toLowerCase() +
  path
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('');

const STATUS_TEXT: Record<string, string> = {
  '200': 'Успешно',
  '201': 'Создано',
  '400': 'Ошибка в запросе',
  '401': 'initData мини-приложения нет или подпись неверна',
  '403': 'Аккаунт MAX не привязан к жителю',
  '404': 'Не найдено',
  '409': 'Конфликт с текущим состоянием',
  '503': 'Сервис не настроен (нет токена бота)',
};

/** Публичные маршруты — через nginx; остальные только из внутренней сети compose (internal-only.ts). */
const isPublic = (url: string): boolean => url === '/health' || url.startsWith('/app/');

function parameters(schema: unknown, where: 'path' | 'query'): Schema[] {
  if (!schema) return [];
  const { properties = {}, required = [] } = plain(schema) as { properties?: Record<string, Schema>; required?: string[] };
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: where,
    required: where === 'path' || required.includes(name),
    ...(typeof property.description === 'string' ? { description: property.description } : {}),
    schema: property,
  }));
}

function operation(route: RouteOptions, method: string, path: string): Schema {
  const schema = (route.schema ?? {}) as {
    description?: string;
    params?: unknown;
    querystring?: unknown;
    body?: unknown;
    response?: Record<string, unknown>;
  };

  const responses = Object.fromEntries(
    Object.entries(schema.response ?? {}).map(([status, body]) => [
      status,
      { description: STATUS_TEXT[status] ?? status, content: { 'application/json': { schema: plain(body) } } },
    ]),
  );

  return {
    operationId: operationId(method, path),
    ...(schema.description ? { summary: schema.description } : {}),
    tags: [isPublic(route.url) ? 'public' : 'internal'],
    // Пустой список — «без авторизации» явно: /health открыт, внутренние закрыты сетью, а не ключом.
    security: route.url.startsWith('/app/') ? [{ maxInitData: [] }] : [],
    parameters: [...parameters(schema.params, 'path'), ...parameters(schema.querystring, 'query')],
    ...(schema.body
      ? { requestBody: { required: true, content: { 'application/json': { schema: plain(schema.body) } } } }
      : {}),
    responses,
  };
}

const routes: RouteOptions[] = [];
const app = buildApp({ rules: loadRules(config.rulesPath) });
app.addHook('onRoute', (route) => {
  routes.push(route);
});
await app.ready();

const paths: Record<string, Record<string, Schema>> = {};
for (const route of routes) {
  // /tickets/:id → /tickets/{id}
  const path = route.url.replace(/:([A-Za-z_]+)/g, '{$1}');
  for (const method of [route.method].flat()) {
    // HEAD Fastify добавляет к каждому GET сам — в контракте его нет.
    if (method === 'HEAD') continue;
    (paths[path] ??= {})[method.toLowerCase()] = operation(route, method, path);
  }
}

const apiMd = readFileSync('../docs/api.md', 'utf8');
const version = /Версия контракта: \*\*([0-9.]+)/.exec(apiMd)?.[1] ?? 'dev';

const document = {
  openapi: '3.1.0',
  info: {
    title: 'Диспетчер обращений ЖКХ в MAX — api',
    version,
    license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    description:
      'Выгружено из схем маршрутов (npm run openapi в api/); подробное описание — docs/api.md.\n\n' +
      '**public** — доступны снаружи: `/health` на домене api и `/app/*` мини-приложения на его домене как `/api/app/*`, ' +
      'с подписью initData MAX в заголовке `X-Max-Init-Data`.\n\n' +
      '**internal** — только из внутренней сети docker compose (бот, команда УК `uk`): запрос через прокси ' +
      'получает 404 `route_not_found` независимо от настроек nginx.',
  },
  servers: [
    {
      url: 'https://{appDomain}/api',
      description: 'мини-приложение: только /app/*',
      variables: { appDomain: { default: 'app.example.ru' } },
    },
    { url: 'https://{apiDomain}', description: 'только /health', variables: { apiDomain: { default: 'api.example.ru' } } },
    { url: 'http://api:3000', description: 'внутренняя сеть docker compose — все маршруты' },
  ],
  tags: [
    { name: 'public', description: 'доступны снаружи' },
    { name: 'internal', description: 'только из внутренней сети compose' },
  ],
  components: {
    securitySchemes: {
      maxInitData: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Max-Init-Data',
        description: 'initData из MAX Bridge (window.WebApp.initData); api проверяет подпись токеном бота',
      },
    },
  },
  paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
};

const out = '../docs/openapi.yaml';
writeFileSync(
  out,
  '# Файл выгружен из схем api: cd api && npm run openapi. Руками не править.\n' +
    stringify(document, { lineWidth: 0 }),
);
console.log(`${out}: ${Object.keys(paths).length} путей, версия контракта ${version}`);

await app.close();
await pool.end();
