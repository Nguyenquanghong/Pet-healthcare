import type { AppointmentStatus, Prisma } from '@prisma/client';
import {
  hotelStatusUpdates,
  notificationCategoryCounts,
  notificationCategoryWhere,
  type NotificationCategory,
} from '@nipopeto/contracts';
import type {
  ClinicalBootstrapSource,
  NotificationBootstrapSource,
} from '../../../infrastructure/persistence/bootstrapRepository.js';
import type { AppointmentInvoiceSource } from '../../../infrastructure/persistence/invoiceRepository.js';
import type { ClinicalListSource } from '../../../infrastructure/persistence/listsRepository.js';

// The appointment side of invoice issuing, moved out of PrismaInvoiceRepository unchanged. It runs on the issuing
// transaction (`tx`), never on the client, so the row lock lasts until the invoice is written.
export const appointmentInvoiceSource: AppointmentInvoiceSource = async (tx, id) => {
  await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
  const item = await tx.appointment.findUnique({ where: { id } });
  return item
    ? {
        ownerId: item.ownerId,
        petId: item.petId,
        status: item.status,
        description: item.serviceName,
        serviceType: item.type,
      }
    : null;
};

const spaTypes = ['spa_bath', 'spa_grooming', 'spa_combo'] as const;

// The appointment, medical record, medical image and notification branches of PrismaListsRepository, moved out
// unchanged. `page` and `related` run on the page's transaction (`tx`) and fill the same ListData the repository
// built; `calendar` runs on the client, as it did there.
export const clinicalListSource: ClinicalListSource = {
  async page(tx, resource, scope, query, data, filters) {
    const { bounds, owner, identity, text, petSearch, joinedSearch } = filters;
    let total = 0;
    let counts: Record<string, number> = {};
    if (resource === 'appointments') {
      const billed =
        query.mode === 'unbilled'
          ? (
              await tx.invoice.findMany({ where: { appointmentId: { not: null } }, select: { appointmentId: true } })
            ).flatMap(row => (row.appointmentId ? [row.appointmentId] : []))
          : [];
      const base: Prisma.AppointmentWhereInput = {
        ...owner,
        ...identity,
        ...(query.date ? { appointmentDate: new Date(`${query.date}T00:00:00Z`) } : {}),
        ...(query.category
          ? { type: query.category === 'spa' ? { in: [...spaTypes] } : { notIn: [...spaTypes] } }
          : {}),
        ...(query.mode === 'unbilled' ? { status: 'completed', AND: [{ id: { notIn: billed } }] } : {}),
        ...(query.q ? { OR: [...joinedSearch(), text('serviceName'), text('id')] } : {}),
      };
      const groupStatuses: Record<string, AppointmentStatus[]> = {
        pending: ['pending', 'confirmed', 'checked_in', 'in_progress'],
        completed: ['completed'],
        cancelled: ['cancelled', 'no_show'],
      };
      const where: Prisma.AppointmentWhereInput = {
        AND: [
          base,
          ...(query.statusGroup ? [{ status: { in: groupStatuses[query.statusGroup] } }] : []),
          ...(query.status ? [{ status: query.status as AppointmentStatus }] : []),
        ],
      };
      const groups = await tx.appointment.groupBy({ by: ['status'], where: base, _count: true });
      counts = Object.fromEntries(groups.map(group => [group.status, group._count]));
      [total, data.appointments] = await Promise.all([
        tx.appointment.count({ where }),
        tx.appointment.findMany({
          where,
          ...bounds,
          orderBy: scope.ownerId
            ? [{ status: 'asc' }, { appointmentDate: 'desc' }, { appointmentTime: 'desc' }, { id: 'desc' }]
            : [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
        }),
      ]);
    } else if (resource === 'medicalRecords') {
      const where: Prisma.MedicalRecordWhereInput = {
        ...owner,
        ...identity,
        ...(query.q ? { OR: [...joinedSearch(), text('title'), text('doctorName'), text('diagnosis')] } : {}),
      };
      [total, data.medicalRecords] = await Promise.all([
        tx.medicalRecord.count({ where }),
        tx.medicalRecord.findMany({ where, ...bounds, orderBy: [{ visitDate: 'desc' }, { id: 'desc' }] }),
      ]);
    } else if (resource === 'medicalImages') {
      const where: Prisma.MedicalImageWhereInput = {
        ...identity,
        ...(scope.ownerId ? { pet: { ownerId: scope.ownerId } } : {}),
        ...(query.petId ? { petId: query.petId } : {}),
        ...(query.q ? { OR: [text('title'), { pet: petSearch() }] } : {}),
      };
      [total, data.medicalImages] = await Promise.all([
        tx.medicalImage.count({ where }),
        tx.medicalImage.findMany({ where, ...bounds, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      ]);
    } else if (resource === 'notifications') {
      // Tab counts ignore the selected tab; status counts and the page respect it.
      const tabs: Prisma.NotificationWhereInput = {
        ...identity,
        ...(scope.ownerId ? { recipientOwnerId: scope.ownerId } : { recipientRole: scope.recipientRole ?? 'admin' }),
        ...(query.q ? { OR: [text('title'), text('message')] } : {}),
      };
      const base: Prisma.NotificationWhereInput = query.category
        ? { AND: [tabs, notificationCategoryWhere(query.category as NotificationCategory)] }
        : tabs;
      const where = { ...base, ...(query.status ? { status: query.status } : {}) };
      const groups = await tx.notification.groupBy({ by: ['status'], where: base, _count: true });
      counts = Object.fromEntries(groups.map(group => [group.status, group._count]));
      const types = await tx.notification.groupBy({ by: ['type'], where: tabs, _count: true });
      const hotelUpdates = await tx.notification.count({ where: { AND: [tabs, hotelStatusUpdates] } });
      for (const [category, n] of Object.entries(
        notificationCategoryCounts(
          types.map(row => ({ type: row.type, count: row._count })),
          hotelUpdates,
        ),
      ))
        counts[`category:${category}`] = n;
      counts['category:all'] = types.reduce((sum, row) => sum + row._count, 0);
      [total, data.notifications] = await Promise.all([
        tx.notification.count({ where }),
        tx.notification.findMany({ where, ...bounds, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      ]);
    }
    return { total, counts };
  },
  async related(tx, resource, scope, data) {
    if (resource === 'medicalRecords')
      data.appointments = await tx.appointment.findMany({
        where: {
          id: { in: data.medicalRecords.flatMap(row => (row.appointmentId ? [row.appointmentId] : [])) },
          ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
        },
      });
  },
  async calendar(client, scope, month, category) {
    const [year, number] = month.split('-').map(Number);
    const rows = await client.appointment.groupBy({
      by: ['appointmentDate'],
      where: {
        ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
        ...(category ? { type: category === 'spa' ? { in: [...spaTypes] } : { notIn: [...spaTypes] } } : {}),
        appointmentDate: { gte: new Date(Date.UTC(year!, number! - 1, 1)), lt: new Date(Date.UTC(year!, number!, 1)) },
      },
      _count: true,
    });
    return Object.fromEntries(rows.map(row => [row.appointmentDate.toISOString().slice(0, 10), row._count]));
  },
};

// The clinical queries of PrismaBootstrapRepository's dashboard summary, moved out unchanged. Each returns the Prisma
// call without awaiting it (and none is `async`): the repository's Promise.all starts them in its own order, on its
// transaction (`tx`).
export const clinicalBootstrap: ClinicalBootstrapSource = {
  appointmentCount: (tx, own) => tx.appointment.count({ where: own }),
  medicalCount: (tx, own) => tx.medicalRecord.count({ where: own }),
  imageCount: (tx, ownerId, own) => tx.medicalImage.count({ where: ownerId ? { pet: own } : {} }),
  appointmentStatus: (tx, own) => {
    // A local, so groupBy infers its row type from the arguments and not from the declared return type.
    const rows = tx.appointment.groupBy({ by: ['status'], where: own, _count: true });
    return rows;
  },
  todayCount: (tx, own, today) => tx.appointment.count({ where: { ...own, appointmentDate: today } }),
  adminAppointments: (tx, today) =>
    Promise.all([
      tx.appointment.findMany({
        where: { appointmentDate: today },
        take: 5,
        orderBy: [{ appointmentTime: 'asc' }, { id: 'asc' }],
      }),
      tx.appointment.findMany({
        where: { status: 'pending' },
        take: 3,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]),
  ownerAppointments: (tx, own, today) =>
    tx.appointment.findMany({
      where: { ...own, status: { in: ['pending', 'confirmed'] }, appointmentDate: { gte: today } },
      take: 5,
      orderBy: [{ appointmentDate: 'asc' }, { appointmentTime: 'asc' }, { id: 'asc' }],
    }),
  medicalRecords: (tx, own, isAdmin) =>
    tx.medicalRecord.findMany({
      where: own,
      take: isAdmin ? 4 : 1,
      orderBy: [{ visitDate: 'desc' }, { id: 'desc' }],
    }),
};

// The notification queries of the same summary; `where` is the recipient filter the repository built.
export const notificationBootstrap: NotificationBootstrapSource = {
  unread: (tx, where) => tx.notification.count({ where: { ...where, status: 'sent' } }),
  count: (tx, where) => tx.notification.count({ where }),
  types: (tx, where) => {
    const rows = tx.notification.groupBy({ by: ['type'], where, _count: true });
    return rows;
  },
  hotelUpdates: (tx, where) => tx.notification.count({ where: { AND: [where, hotelStatusUpdates] } }),
  latest: (tx, where) =>
    tx.notification.findMany({
      where,
      take: 5,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
};
