import type { PrismaClient } from '../../generated/client/index.js';
import type { ReadinessProbe } from '../../application/ports/readiness.js';

export class PrismaReadiness implements ReadinessProbe {
  constructor(private readonly db: PrismaClient) {}
  async check() {
    await this.db.appointment.count();
    await this.db.medicalRecord.count();
    await this.db.medicalImage.count();
    await this.db.requestDedup.count();
  }
}
