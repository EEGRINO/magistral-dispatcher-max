/**
 * Единый формат ошибок API.
 *
 * Любая ошибка наружу выглядит так:
 *   { "error": { "code": "not_found", "message": "...", "details": [...] } }
 *
 * `code` — машиночитаемый, по нему клиент ветвится. `message` — для человека,
 * его формулировка может меняться без предупреждения; `code` — часть контракта.
 */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (message: string): ApiError => new ApiError(404, 'not_found', message);

export const invalidReference = (message: string): ApiError =>
  new ApiError(400, 'invalid_reference', message);

/** Минимум полей ошибки node-postgres, который нам нужен. */
interface PgError {
  code: string;
  detail?: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

/**
 * Переводит ошибки PostgreSQL в осмысленные HTTP-ответы.
 * Возвращает null, если ошибка не про целостность данных — такую наверх
 * отдавать нельзя, она уйдёт в 500 с записью в лог.
 */
export function mapPgError(error: unknown): ApiError | null {
  if (!isPgError(error)) return null;

  switch (error.code) {
    // foreign_key_violation — клиент прислал id несуществующей записи.
    // Это ошибка запроса, а не сервера, поэтому 400, а не 500.
    case '23503':
      return invalidReference(
        `Ссылка на несуществующую запись${error.constraint ? ` (${error.constraint})` : ''}`,
      );

    // unique_violation
    case '23505':
      return new ApiError(
        409,
        'conflict',
        `Запись с такими данными уже существует${error.constraint ? ` (${error.constraint})` : ''}`,
      );

    // check_violation
    case '23514':
      return new ApiError(
        400,
        'constraint_violation',
        `Значение не проходит проверку${error.constraint ? ` (${error.constraint})` : ''}`,
      );

    default:
      return null;
  }
}
