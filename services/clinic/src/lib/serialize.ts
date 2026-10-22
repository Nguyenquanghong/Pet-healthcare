import type { AppointmentRecord } from '../application/ports/appointments.js';
import type { MedicalRecordValue } from '../application/ports/medicalRecords.js';
export { medicalImageDto } from '../application/services/medicalRecords.js';
const dateOnly=(value:Date)=>value.toISOString().slice(0,10);
export function appointmentDto(item: AppointmentRecord, owner = false) {
  const { internalNote, ...visible } = item;
  return { ...visible, ...(owner ? {} : { internalNote }), date: dateOnly(item.appointmentDate), time: item.appointmentTime, appointmentDate: undefined, appointmentTime: undefined };
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
