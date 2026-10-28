import { Prisma, type PrismaClient } from './generated/client/index.js';
import {
  hotelStatusUpdates,
  isNotificationCategory,
  notificationCategoryCounts,
  notificationCategoryWhere,
  type NotificationCategory,
} from '@nipopeto/contracts';

export interface Actor {
  sub: string;
  role: 'owner' | 'doctor' | 'staff' | 'admin';
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function parseQuery(raw: Record<string, unknown>) {
  const integer = (key: string, fallback: number, max: number) => {
    if (raw[key] === undefined) return fallback;
    if (typeof raw[key] !== 'string' || !/^[1-9]\d*$/.test(raw[key] as string))
      throw new ApiError(422, `Invalid ${key}.`);
    const n = Number(raw[key]);
    if (!Number.isSafeInteger(n) || n > max) throw new ApiError(422, `${key} exceeds ${max}.`);
    return n;
  };
  const query: {
    page: number;
    pageSize: number;
    q?: string;
    id?: string;
    status?: string;
    category?: NotificationCategory;
  } = {
    page: integer('page', 1, 1_000_000),
    pageSize: integer('pageSize', 20, 100),
  };
  for (const key of ['q', 'id', 'status', 'category'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || (raw[key] as string).length > (key === 'q' ? 100 : 128))
      throw new ApiError(422, `Invalid ${key}.`);
    const value = (raw[key] as string).trim();
    if (!value || (value === 'all' && key !== 'q' && key !== 'id')) continue;
    if (
      (key === 'status' && !['sent', 'read'].includes(value)) ||
      (key === 'category' && !isNotificationCategory(value))
    )
      throw new ApiError(422, `Invalid ${key}.`);
    if (key === 'category') query.category = value as NotificationCategory;
    else query[key] = value;
  }
  return query;
}
const scope = (actor: Actor): Prisma.NotificationWhereInput =>
  actor.role === 'owner' ? { recipientOwnerId: actor.sub } : { recipientRole: 'admin' };
const related = () => ({
  owners: [],
  pets: [],
  appointments: [],
  hotelBookings: [],
  medicalRecords: [],
  medicalImages: [],
  dailyCareNotes: [],
  notifications: [],
  invoices: [],
});

export class Notifications {
  constructor(private readonly db: PrismaClient) {}
  async list(actor: Actor, raw: Record<string, unknown>) {
    const query = parseQuery(raw);
    return this.db.$transaction(
      async tx => {
        // Tab counts ignore the selected tab; status counts and the page respect it.
        const tabs: Prisma.NotificationWhereInput = {
          ...scope(actor),
          ...(query.id ? { id: query.id } : {}),
          ...(query.q
            ? {
                OR: [
                  { title: { contains: query.q, mode: 'insensitive' } },
                  { message: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        };
        const base: Prisma.NotificationWhereInput = query.category
          ? { AND: [tabs, notificationCategoryWhere(query.category)] }
          : tabs;
        const where = { ...base, ...(query.status ? { status: query.status } : {}) };
        const groups = await tx.notification.groupBy({ by: ['status'], where: base, _count: true });
        const counts: Record<string, number> = Object.fromEntries(groups.map(g => [g.status, g._count]));
        const types = await tx.notification.groupBy({ by: ['type'], where: tabs, _count: true });
        const hotelUpdates = await tx.notification.count({ where: { AND: [tabs, hotelStatusUpdates] } });
        for (const [category, n] of Object.entries(
          notificationCategoryCounts(
            types.map(row => ({ type: row.type, count: row._count })),
            hotelUpdates,
          ),
        ))
          counts[`category:${category}`] = n;
        counts['category:all'] = types.reduce((n, row) => n + row._count, 0);
        const [total, items] = await Promise.all([
          tx.notification.count({ where }),
          tx.notification.findMany({
            where,
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        ]);
        return {
          items,
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total,
            totalPages: Math.ceil(total / query.pageSize),
          },
          counts,
          related: related(),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async unread(actor: Actor) {
    return this.db.$transaction(
      async tx => {
        const unread = await tx.notification.count({ where: { ...scope(actor), status: 'sent' } });
        const [time] = await tx.$queryRaw<{ asOf: Date }[]>`SELECT transaction_timestamp() AS "asOf"`;
        return { unread, asOf: time.asOf.toISOString() };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async markAllRead(actor: Actor) {
    await this.db.notification.updateMany({ where: { ...scope(actor), status: 'sent' }, data: { status: 'read' } });
  }
  async markRead(actor: Actor, id: string) {
    return this.db.$transaction(async tx => {
      const result = await tx.notification.updateMany({ where: { ...scope(actor), id }, data: { status: 'read' } });
      if (!result.count) throw new ApiError(404, 'Notification not found.');
      return tx.notification.findUniqueOrThrow({ where: { id } });
    });
  }
  async delete(actor: Actor, id: string) {
    const result = await this.db.notification.deleteMany({ where: { ...scope(actor), id } });
    if (!result.count) throw new ApiError(404, 'Notification not found.');
    // Inbox history deliberately survives deletion.
  }
}
