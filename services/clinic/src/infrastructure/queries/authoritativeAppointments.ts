import type { PrismaClient } from '../../generated/client/index.js';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import type {
  AppointmentQueries,
  AppointmentCalendarQuery,
  AppointmentCalendarResult,
  AppointmentQueryDirectory,
  AppointmentListResult,
} from '../../application/ports/appointmentQueries.js';
import { list } from './authoritativeLists.js';

type CalendarDatabase = { appointment: Pick<PrismaClient['appointment'], 'groupBy'> };
const spa = ['spa_bath', 'spa_grooming', 'spa_combo'] as const;

export class AuthoritativeAppointmentQueries implements AppointmentQueries {
  constructor(
    private readonly db: CalendarDatabase & Pick<PrismaClient, '$transaction' | 'appointment' | 'directoryProjection'>,
  ) {}

  list(
    actor: Actor,
    directory: AppointmentQueryDirectory,
    raw: Record<string, unknown>,
  ): Promise<AppointmentListResult> {
    return list(this.db, 'appointments', actor, directory, raw);
  }

  async calendar(actor: Actor, { month, category }: AppointmentCalendarQuery): Promise<AppointmentCalendarResult> {
    if (
      typeof month !== 'string' ||
      !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) ||
      (category !== undefined && !['medical', 'spa'].includes(String(category)))
    ) {
      throw new BusinessError(422, 'Invalid month or category.');
    }
    const [y, m] = month.split('-').map(Number);
    const rows = await this.db.appointment.groupBy({
      by: ['appointmentDate'],
      where: {
        ...(actor.role === 'owner' ? { ownerId: actor.sub } : {}),
        ...(category ? { type: category === 'spa' ? { in: [...spa] } : { notIn: [...spa] } } : {}),
        appointmentDate: { gte: new Date(Date.UTC(y!, m! - 1, 1)), lt: new Date(Date.UTC(y!, m!, 1)) },
      },
      _count: true,
    });
    return Object.fromEntries(rows.map(row => [row.appointmentDate.toISOString().slice(0, 10), row._count]));
  }
}
