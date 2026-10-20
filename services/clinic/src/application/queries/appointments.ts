import type { AppointmentQueries } from '../ports/appointmentQueries.js';

export type ClinicReadMode = 'authoritative' | 'shadow' | 'projection';

// Plain readers cannot serve projection directly: Q4 HTTP composition must
// use ServingAppointmentQueries for tokens, freshness and bounded fallback.
export function selectAppointmentQueries(authoritative: AppointmentQueries, mode: unknown = 'authoritative', shadow?:AppointmentQueries): AppointmentQueries {
  if (mode !== 'authoritative' && mode !== 'shadow' && mode !== 'projection') {
    throw new Error('INVALID_CLINIC_READ_MODE');
  }
  if(mode==='shadow'&&shadow)return shadow;
  if (mode !== 'authoritative')throw new Error('CLINIC_READ_MODE_NOT_AVAILABLE');
  return authoritative;
}
