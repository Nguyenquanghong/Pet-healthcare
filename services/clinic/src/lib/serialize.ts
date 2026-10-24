import { allowedActions } from '@nipopeto/contracts';
import type { AppointmentRecord } from '../application/ports/appointments.js';
import type { Actor } from '../domain/auth.js';
import type { MedicalRecordValue } from '../application/ports/medicalRecords.js';
export { medicalImageDto } from '../application/services/medicalRecords.js';
const dateOnly=(value:Date)=>value.toISOString().slice(0,10);
// P01: allowedActions tells the viewer which buttons to offer; the server still checks.
export function appointmentDto(item: AppointmentRecord, viewer: Pick<Actor, 'role' | 'sub'>) {
  const { internalNote, ...visible } = item, owner = viewer.role === 'owner';
  return { ...visible, ...(owner ? {} : { internalNote }), date: dateOnly(item.appointmentDate), time: item.appointmentTime, appointmentDate: undefined, appointmentTime: undefined,
    allowedActions: allowedActions('appointment', item.status, viewer.role, owner && item.ownerId === viewer.sub) };
}

export function medicalRecordDto(item: MedicalRecordValue, owner = false) {
  const { internalNote, ...visible } = item;
  return {
    ...visible, ...(owner ? {} : { internalNote }),
    visitDate: dateOnly(item.visitDate),
    followUpDate: item.followUpDate ? dateOnly(item.followUpDate) : undefined,
    weightKg: item.weightKg === null ? undefined : Number(item.weightKg),
    temperatureC: item.temperatureC === null ? undefined : Number(item.temperatureC),
  };
}
