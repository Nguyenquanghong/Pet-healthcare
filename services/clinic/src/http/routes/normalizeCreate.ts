import { BusinessError } from '../../domain/error.js';
import { calendarDate, requiredText } from '../../domain/validation.js';
import { medicalFields } from '../../application/services/medicalRecords.js';
import { appointmentTypes } from '../../application/ports/appointments.js';

// Hash only fields the use case consumes, with its defaults/trim semantics.
export function normalizeCreate(input: Record<string, unknown>, record: boolean) {
  if (record) return { petId: requiredText(input.petId, 'Pet', 200), ...medicalFields(input) };
  const names = record
    ? [
        'petId',
        'appointmentId',
        'doctorName',
        'visitDate',
        'title',
        'symptoms',
        'diagnosis',
        'treatment',
        'medications',
        'vaccineName',
        'followUpDate',
        'weightKg',
        'temperatureC',
        'heartRateBpm',
        'internalNote',
      ]
    : ['petId', 'type', 'date', 'time', 'serviceName', 'doctorId', 'clinicName', 'ownerNote'];
  const value: Record<string, unknown> = {};
  for (const k of names) {
    const v = input[k];
    value[k] =
      typeof v === 'string' ? (record || ['serviceName', 'ownerNote'].includes(k) ? v.trim() : v) : (v ?? null);
  }
  if (!record) {
    value.type = value.type || 'other';
    value.clinicName = value.clinicName || 'Nippon Pet Care';
    value.ownerNote = value.ownerNote || null;
    value.doctorId = value.doctorId || null;
  }
  if (
    !appointmentTypes.includes(value.type as (typeof appointmentTypes)[number]) ||
    typeof value.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
  )
    throw new BusinessError(422, 'Invalid appointment service or time.');
  calendarDate(value.date, 'Appointment date');
  requiredText(value.serviceName, 'Service');
  // Calendar validation stays independent of current time: a committed retry
  // remains replayable tomorrow. The use case checks Vietnam today on creation.
  for (const k of ['doctorId', 'clinicName', 'ownerNote'])
    if (value[k] !== null && typeof value[k] !== 'string') throw new BusinessError(422, `Invalid ${k}.`);
  return value;
}
