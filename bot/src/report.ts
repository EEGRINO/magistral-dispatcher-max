/**
 * Обычная заявка в диалоге: что случилось → где → граница зоны собственника →
 * описание → подтверждение. Согласовано 24.09.2026 (docs/Решения_проекта.md).
 *
 * Здесь только справочник: коды, подписи и правило зоны собственника. Коды —
 * это problem_type и place заявки, по ним будет работать маршрутизация.
 * TODO(Павел): перечень категорий и границы — перенести в config/rules.yaml.
 */

export const CATEGORIES = {
  water: 'Вода, канализация',
  heating: 'Отопление',
  electricity: 'Электричество',
  elevator: 'Лифт',
  common_area: 'Подъезд, двор, уборка',
  other: 'Другое',
} as const;
export type Category = keyof typeof CATEGORIES;

export const PLACES = {
  apartment: 'в квартире',
  entrance: 'в подъезде, на лестнице',
  building: 'в подвале, на крыше или во дворе',
} as const;
export type Place = keyof typeof PLACES;

/**
 * Лифт и подъезд — всегда общее имущество, спрашивать «где» незачем.
 * Для остальных место нужно: от него зависит зона собственника.
 */
export const asksPlace = (category: Category): boolean => category !== 'elevator' && category !== 'common_area';

/**
 * Где граница ответственности УК в квартире (ПП РФ № 491, п. 5 и 7): вода —
 * первый кран на отводе от стояка, электричество — квартирный счётчик. У
 * отопления в квартире границы не спрашиваем: радиатор без отключающего крана
 * — общее имущество, и отказать жителю по ошибке хуже, чем принять лишнюю заявку.
 */
export type BoundaryCategory = 'water' | 'electricity';
export const hasBoundary = (category: Category, place: Place | undefined): category is BoundaryCategory =>
  place === 'apartment' && (category === 'water' || category === 'electricity');

/** Ответ на вопрос о границе: УК / собственник / житель не знает — тогда в УК. */
export const BOUNDARY_ANSWERS = ['uk', 'owner', 'unknown'] as const;
export type BoundaryAnswer = (typeof BOUNDARY_ANSWERS)[number];

export const isCategory = (value: string): value is Category => value in CATEGORIES;
export const isPlace = (value: string): value is Place => value in PLACES;
export const isBoundaryAnswer = (value: string): value is BoundaryAnswer =>
  (BOUNDARY_ANSWERS as readonly string[]).includes(value);

/** Черновик заявки — в памяти бота, как ожидание адреса. */
export interface ReportDraft {
  residentId: number;
  step: 'category' | 'place' | 'boundary' | 'description' | 'confirm';
  category?: Category;
  place?: Place;
  description?: string | null;
}
