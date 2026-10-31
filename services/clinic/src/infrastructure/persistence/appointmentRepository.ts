import type { Prisma, PrismaClient } from '../../generated/client/index.js';
import type {
  AppointmentRepository,
  AppointmentDependencies,
  AppointmentType,
} from '../../application/ports/appointments.js';
import { appointmentSlotWrite } from './appointmentSlotConflict.js';
import type { RequestDirectory } from '../core/directory.js';
import { transaction, writer, type Client } from './shared.js';

class Appointments implements AppointmentRepository {
  constructor(
    private readonly db: Client,
    private readonly directory: RequestDirectory,
  ) {}
  list(ownerId?: string) {
    return this.db.appointment.findMany({
      where: { ownerId },
      orderBy: [{ appointmentDate: 'desc' }, { appointmentTime: 'desc' }],
    });
  }
  findPet(id: string) {
    return this.directory.pet(id);
  }
  find(id: string) {
    return this.db.appointment.findUnique({ where: { id } });
  }
  async findWithPet(id: string) {
    const appointment = await this.find(id);
    return appointment ? { appointment, pet: await this.directory.pet(appointment.petId) } : null;
  }
  async slotPolicy(type: AppointmentType) {
    const policy = await this.db.appointmentTypePolicy.findUniqueOrThrow({ where: { type } }),
      group = await this.db.appointmentResourceGroup.findUniqueOrThrow({
        where: { resourceGroup: policy.resourceGroup },
      });
    return {
      type,
      resourceGroup: group.resourceGroup,
      durationMinutes: policy.durationMinutes,
      capacity: group.capacity,
      openTime: group.openTime,
      closeTime: group.closeTime,
      stepMinutes: group.stepMinutes,
      fixedSlots: group.fixedSlots,
    };
  }
  slotUsage(resourceGroup: string, from: Date, to: Date) {
    return this.db.appointmentSlotUsage.findMany({
      where: { resourceGroup, slotStart: { gte: from, lt: to } },
      select: { slotStart: true, booked: true, capacity: true },
    });
  }
  async doctorSlots(doctorId: string, from: Date, to: Date) {
    return (
      await this.db.appointmentDoctorSlot.findMany({
        where: { doctorId, slotStart: { gte: from, lt: to } },
        select: { slotStart: true },
      })
    ).map(s => s.slotStart);
  }
  async create(data: Parameters<AppointmentRepository['create']>[0]) {
    const row = await appointmentSlotWrite(this.db.appointment.create({ data }));
    return row;
  }
}
export function appointmentDependencies(
  db: PrismaClient,
  directory: RequestDirectory,
  bound?: Prisma.TransactionClient,
): AppointmentDependencies {
  const c = bound ?? db;
  return {
    appointments: new Appointments(c, directory),
    notifications: writer(c),
    unitOfWork: {
      run: work =>
        transaction(db, bound, tx =>
          work({ appointments: new Appointments(tx, directory), notifications: writer(tx) }),
        ),
    },
  };
}
