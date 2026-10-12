import { useApiQuery } from './useApiQuery';
import type { Pet } from '../types/pet';
import type { Owner } from '../types/owner';
import type { HotelBooking } from '../types/booking';
import type { Appointment } from '../types/appointment';
import type { MedicalRecord } from '../types/medicalRecord';
type CoreRegion = { asOf: string; pets: Pet[]; owners: Owner[]; hotelBookings: HotelBooking[]; summary: { totals: Record<string,number>; species: Record<string,number>; hotelStatus: Record<string,number> } };
type ClinicRegion = { asOf: string; pets: Pet[]; owners: Owner[]; appointments: Appointment[]; medicalRecords: MedicalRecord[]; summary: { totals: Record<string,number>; appointmentStatus: Record<string,number>; todayAppointments: number } };
export function useDashboard() {
  const core = useApiQuery<CoreRegion>('/dashboard/core', { refreshOnTick: true });
  const clinic = useApiQuery<ClinicRegion>('/dashboard/clinic', { refreshOnTick: true });
  const pets = [...new Map([...(core.data?.pets??[]),...(clinic.data?.pets??[])].map(pet=>[pet.id,pet])).values()];
  const owners = [...new Map([...(core.data?.owners??[]),...(clinic.data?.owners??[])].map(owner=>[owner.id,owner])).values()];
  return { core, clinic, pets, owners, ownerPets: core.data?.pets??[], appointments: clinic.data?.appointments??[], hotelBookings:core.data?.hotelBookings??[],medicalRecords:clinic.data?.medicalRecords??[],
    summary:{totals:{...core.data?.summary.totals,...clinic.data?.summary.totals},species:core.data?.summary.species??{},hotelStatus:core.data?.summary.hotelStatus??{},appointmentStatus:clinic.data?.summary.appointmentStatus??{},todayAppointments:clinic.data?.summary.todayAppointments} };
}
