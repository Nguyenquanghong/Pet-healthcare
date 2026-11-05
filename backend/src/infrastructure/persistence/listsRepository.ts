import {
  Prisma,
  type PrismaClient,
  type PetSpecies,
  type PetHealthStatus,
  type HotelBookingStatus,
  type RoomType,
  type PaymentStatus,
} from '@prisma/client';
import type { ListsRepository, ListData, ListQuery, ListResource, ListScope } from '../../application/ports/lists.js';

export const emptyListData = (): ListData => ({
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

// The filters every list shares. The clinical source builds its where-clauses from the same ones.
export const listFilters = (scope: ListScope, query: ListQuery) => {
  const bounds = { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
  const ownerId = scope.ownerId ?? query.ownerId;
  const identity = { ...(query.id ? { id: query.id } : {}) };
  const owner = { ...(ownerId ? { ownerId } : {}), ...(query.petId ? { petId: query.petId } : {}) };
  const text = (field: string) => ({ [field]: { contains: query.q!, mode: 'insensitive' as const } });
  const contact = (): Prisma.UserWhereInput => ({ OR: [text('fullName'), text('phone'), text('email'), text('id')] });
  const petSearch = (): Prisma.PetWhereInput => ({
    OR: [text('name'), text('breed'), text('microchipId'), text('id'), { owner: contact() }],
  });
  const joinedSearch = () => (query.q ? [{ pet: petSearch() }, { owner: contact() }] : []);
  return { bounds, ownerId, identity, owner, text, contact, petSearch, joinedSearch };
};
export type ListFilters = ReturnType<typeof listFilters>;

// Appointment, medical record, medical image and notification lists. Legacy supplies it (see legacy/infrastructure/persistence/clinicalSources.ts).
export interface ClinicalListSource {
  // The resource's branch of `page`: fills `data` on the page's transaction and returns the total and status counts.
  page(
    tx: Prisma.TransactionClient,
    resource: ListResource,
    scope: ListScope,
    query: ListQuery,
    data: ListData,
    filters: ListFilters,
  ): Promise<{ total: number; counts: Record<string, number> }>;
  // The clinical rows a core list shows beside its own (medical records show their appointments).
  related(tx: Prisma.TransactionClient, resource: ListResource, scope: ListScope, data: ListData): Promise<void>;
  calendar(client: PrismaClient, scope: ListScope, month: string, category?: string): Promise<Record<string, number>>;
}

export class PrismaListsRepository implements ListsRepository {
  constructor(
    private readonly client: PrismaClient,
    private readonly clinical?: ClinicalListSource,
  ) {}
  async page(resource: ListResource, scope: ListScope, query: ListQuery) {
    return this.client.$transaction(
      async tx => {
        const data = emptyListData();
        const filters = listFilters(scope, query);
        const { bounds, ownerId, identity, contact, petSearch } = filters;
        let total = 0;
        let counts: Record<string, number> = {};
        if (resource === 'owners') {
          const where: Prisma.UserWhereInput = {
            role: 'owner',
            ...(ownerId ? { id: ownerId } : {}),
            ...identity,
            ...(query.q ? contact() : {}),
          };
          [total, data.owners] = await Promise.all([
            tx.user.count({ where }),
            tx.user.findMany({
              where,
              ...bounds,
              include: { pets: { select: { id: true }, take: 0 }, _count: { select: { pets: true } } },
              orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
            }),
          ]);
        } else if (resource === 'pets') {
          const where: Prisma.PetWhereInput = {
            ...(ownerId ? { ownerId } : {}),
            ...identity,
            ...(query.species ? { species: query.species as PetSpecies } : {}),
            ...(query.healthStatus ? { healthStatus: query.healthStatus as PetHealthStatus } : {}),
            ...(query.q ? petSearch() : {}),
          };
          [total, data.pets] = await Promise.all([
            tx.pet.count({ where }),
            tx.pet.findMany({ where, ...bounds, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
          ]);
        } else if (resource === 'hotelBookings') {
          ({ total, counts } = await this.hotelBookingPage(tx, query, data, filters));
        } else if (resource === 'dailyCareNotes') {
          const where: Prisma.DailyCareNoteWhereInput = {
            ...identity,
            ...(scope.ownerId ? { booking: { ownerId: scope.ownerId }, visibleToOwner: true } : {}),
            ...(query.bookingId ? { bookingId: query.bookingId } : {}),
          };
          [total, data.dailyCareNotes] = await Promise.all([
            tx.dailyCareNote.count({ where }),
            tx.dailyCareNote.findMany({ where, ...bounds, orderBy: [{ noteDate: 'desc' }, { id: 'desc' }] }),
          ]);
        } else if (
          resource === 'appointments' ||
          resource === 'medicalRecords' ||
          resource === 'medicalImages' ||
          resource === 'notifications'
        ) {
          if (!this.clinical) throw new Error('LIST_RESOURCE_UNAVAILABLE');
          ({ total, counts } = await this.clinical.page(tx, resource, scope, query, data, filters));
        } else if (resource === 'invoices') {
          ({ total, counts } = await this.invoicePage(tx, query, data, filters));
        }
        await this.relations(tx, resource, scope, data);
        return { data, total, counts };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  // The hotel booking branch of `page`, unchanged.
  private async hotelBookingPage(tx: Prisma.TransactionClient, query: ListQuery, data: ListData, filters: ListFilters) {
    const { bounds, owner, identity, text, joinedSearch } = filters;
    let total = 0;
    let counts: Record<string, number> = {};
    const base: Prisma.HotelBookingWhereInput = {
      ...owner,
      ...identity,
      ...(query.roomType ? { roomType: query.roomType as RoomType } : {}),
      ...(query.mode === 'unbilled' ? { status: { in: ['in_stay', 'checked_out'] }, invoices: { none: {} } } : {}),
      ...(query.q ? { OR: [...joinedSearch(), text('id')] } : {}),
    };
    const where: Prisma.HotelBookingWhereInput = {
      AND: [base, ...(query.status ? [{ status: query.status as HotelBookingStatus }] : [])],
    };
    const groups = await tx.hotelBooking.groupBy({ by: ['status'], where: base, _count: true });
    counts = Object.fromEntries(groups.map(group => [group.status, group._count]));
    [total, data.hotelBookings] = await Promise.all([
      tx.hotelBooking.count({ where }),
      tx.hotelBooking.findMany({
        where,
        ...bounds,
        include: { dailyCareNotes: { select: { id: true }, take: 0 } },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    return { total, counts };
  }
  // The invoice branch of `page`, unchanged.
  private async invoicePage(tx: Prisma.TransactionClient, query: ListQuery, data: ListData, filters: ListFilters) {
    const { bounds, owner, identity, text, joinedSearch } = filters;
    let total = 0;
    let counts: Record<string, number> = {};
    const base: Prisma.InvoiceWhereInput = {
      ...owner,
      ...identity,
      ...(query.bookingId ? { hotelBookingId: query.bookingId } : {}),
      ...(query.q ? { OR: [...joinedSearch(), text('invoiceCode'), text('transferCode'), text('id')] } : {}),
    };
    const where = { ...base, ...(query.status ? { paymentStatus: query.status as PaymentStatus } : {}) };
    const groups = await tx.invoice.groupBy({ by: ['paymentStatus'], where: base, _count: true });
    counts = Object.fromEntries(groups.map(group => [group.paymentStatus, group._count]));
    [total, data.invoices] = await Promise.all([
      tx.invoice.count({ where }),
      tx.invoice.findMany({
        where,
        ...bounds,
        include: { items: true },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    return { total, counts };
  }
  // The owners, pets and invoices of the rows on this page, in the order the page always loaded them.
  private async relations(tx: Prisma.TransactionClient, resource: ListResource, scope: ListScope, data: ListData) {
    // Fetch only relations of rows on this page, instead of all owners/pets in the database.
    const rows = [
      ...data.appointments,
      ...data.hotelBookings,
      ...data.medicalRecords,
      ...data.medicalImages,
      ...data.invoices,
    ];
    if (this.clinical) await this.clinical.related(tx, resource, scope, data);
    if (resource === 'hotelBookings' && data.hotelBookings.length)
      data.invoices = await tx.invoice.findMany({
        where: {
          hotelBookingId: { in: data.hotelBookings.map(row => row.id) },
          ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
        },
        include: { items: true },
      });
    const petIds = [...new Set(rows.map(row => row.petId))];
    if (resource !== 'pets' && petIds.length)
      data.pets = await tx.pet.findMany({
        where: { id: { in: petIds }, ...(scope.ownerId ? { ownerId: scope.ownerId } : {}) },
      });
    const ownerIds = [
      ...new Set([
        ...data.pets.map(pet => pet.ownerId),
        ...data.appointments.map(row => row.ownerId),
        ...data.hotelBookings.map(row => row.ownerId),
        ...data.invoices.map(row => row.ownerId),
      ]),
    ];
    if (resource !== 'owners' && ownerIds.length)
      data.owners = await tx.user.findMany({
        where: { id: { in: ownerIds }, ...(scope.ownerId ? { id: scope.ownerId } : {}) },
        include: { pets: { select: { id: true }, take: 0 } },
      });
  }
  doctors() {
    return this.client.user.findMany({
      where: { role: 'doctor' },
      select: { id: true, fullName: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    });
  }
  async billingFigures(month?: string) {
    let range: { gte: Date; lt: Date } | undefined;
    if (month) {
      const [year, number] = month.split('-').map(Number);
      range = {
        gte: new Date(Date.UTC(year!, number! - 1, 1) - 7 * 3_600_000),
        lt: new Date(Date.UTC(year!, number!, 1) - 7 * 3_600_000),
      };
    }
    return this.client.$transaction(
      async tx => {
        const paid = await tx.invoice.groupBy({
          by: ['type'],
          where: { paymentStatus: 'paid', ...(range ? { paidAt: range } : {}) },
          _sum: { totalAmount: true },
          _count: true,
        });
        const unpaid = await tx.invoice.aggregate({
          where: { paymentStatus: 'unpaid', ...(range ? { issuedAt: range } : {}) },
          _sum: { totalAmount: true },
          _count: true,
        });
        const sum = (type?: string) =>
          paid
            .filter(row => !type || row.type === type)
            .reduce((total, row) => total + Number(row._sum.totalAmount ?? 0), 0);
        return {
          received: sum(),
          hotel: sum('hotel_booking'),
          appointment: sum('appointment'),
          outstanding: Number(unpaid._sum.totalAmount ?? 0),
          paidCount: paid.reduce((total, row) => total + row._count, 0),
          unpaidCount: unpaid._count,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async calendar(scope: ListScope, month: string, category?: string) {
    if (!this.clinical) throw new Error('LIST_RESOURCE_UNAVAILABLE');
    return this.clinical.calendar(this.client, scope, month, category);
  }
}
