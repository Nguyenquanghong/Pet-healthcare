import type { PrismaClient } from '../../generated/client/index.js';
import type { ScopeLookup } from '../../application/ports/requestScope.js';

export class PrismaScopeLookup implements ScopeLookup {
  constructor(private readonly db: PrismaClient) {}
  async petOfAppointment(id: string) {
    const row = await this.db.appointment.findUnique({ where: { id } });
    return row ? row.petId : null;
  }
  async petOfMedicalRecord(id: string) {
    const row = await this.db.medicalRecord.findUnique({ where: { id } });
    return row ? row.petId : null;
  }
  async petOfMedicalImage(id: string) {
    const row = await this.db.medicalImage.findUnique({ where: { id }, select: { petId: true } });
    return row ? row.petId : null;
  }
  async petOfDeletedRecord(id: string) {
    const last = await this.db.medicalRecordRevision.findFirst({
      where: { recordId: id },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    });
    const snapshot = (last?.before ?? last?.after) as { petId?: unknown } | null | undefined;
    return typeof snapshot?.petId === 'string' ? snapshot.petId : null;
  }
}
