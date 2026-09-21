import type { Contract, Ticket } from '../types/domain';

/**
 * Справочник договоров, который «знает» заглушка бэкенда: по номеру из квитанции
 * определяется адрес. В реальности это запрос к базе управляющей компании.
 */
export const KNOWN_CONTRACTS: Contract[] = [
  { id: '77012', street: 'Ленина', house: '10', flat: '15' },
  { id: '81450', street: 'Гагарина', house: '3', block: '2', flat: '51' },
  { id: '90333', street: 'Советская', house: '7', flat: '4' },
];

export const MOCK_TICKETS: Ticket[] = [
  {
    id: 101,
    contractId: '77012',
    address: 'ул. Ленина, д. 10, кв. 15',
    type: 'pipe',
    status: 'review',
    description: 'В подвале под подъездом течёт вода, слышен шум в стояке.',
    createdAt: '2026-09-20T09:12:00.000Z',
  },
  {
    id: 100,
    contractId: '77012',
    address: 'ул. Ленина, д. 10, кв. 15',
    type: 'electricity',
    status: 'work',
    description: 'Мигает свет на кухне, периодически выбивает автомат.',
    createdAt: '2026-09-19T16:40:00.000Z',
  },
  {
    id: 99,
    contractId: '81450',
    address: 'ул. Гагарина, д. 3, корп. 2, кв. 51',
    type: 'heating',
    status: 'done',
    description: 'Холодные батареи в комнате, в остальных квартирах тепло.',
    createdAt: '2026-09-18T11:05:00.000Z',
  },
];
