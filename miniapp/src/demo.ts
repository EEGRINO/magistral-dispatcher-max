/**
 * ДЕМО-ДАННЫЕ — только чтобы посмотреть интерфейс, пока мини-апп не подключён
 * к api. Удалить вместе с импортом в App.tsx, когда появятся маршруты api
 * мини-аппа. Дом и организации — из db/seed.js (дома Павла, г. Заречный).
 */
import type { House, Ticket } from './types/domain';

export const DEMO_HOUSE: House = {
  address: 'г. Заречный, ул. Полевая, д. 5',
  // Заглушка: у настоящего дома ссылку на чат заводит УК.
  chat_link: 'https://max.ru',
  emergency_phone: '+7 900 111-00-01',
  has_gas: true,
  uk_name: 'ООО «УК Маяк»',
};

export const DEMO_TICKETS: Ticket[] = [
  {
    id: 14,
    problem_type: 'leak',
    place: 'in_apartment',
    description: 'Капает из стояка в ванной, под трубой собирается лужа.',
    status: 'in_progress',
    created_at: '2026-09-24T07:40:00.000Z',
    responsible_name: 'ООО «УК Маяк»',
    deadline_at: null,
    deadline_verified: false,
  },
  {
    id: 12,
    problem_type: 'heating',
    place: 'whole_house',
    description: 'Во всём подъезде холодные батареи со вчерашнего вечера.',
    status: 'new',
    created_at: '2026-09-23T18:15:00.000Z',
    responsible_name: 'АО «Теплосеть»',
    deadline_at: null,
    deadline_verified: false,
  },
  {
    id: 9,
    problem_type: 'elevator',
    place: 'entrance',
    description: null,
    status: 'resolved',
    created_at: '2026-09-20T10:05:00.000Z',
    responsible_name: 'ООО «УК Маяк»',
    deadline_at: null,
    deadline_verified: false,
  },
];
