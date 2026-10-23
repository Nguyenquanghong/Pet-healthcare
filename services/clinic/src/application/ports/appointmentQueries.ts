import type { Actor } from '../../domain/auth.js';
import type { AppointmentRecord } from './appointments.js';
import type { DirectoryLookup, DirectorySnapshot } from './directory.js';

export type AppointmentCalendarQuery = { month: unknown; category?: unknown };
export type AppointmentCalendarResult = Record<string, number>;

export interface AppointmentCalendarQueries {
  calendar(actor: Actor, query: AppointmentCalendarQuery): Promise<AppointmentCalendarResult>;
}

// Lists resolve pets and owners only; doctor lookup belongs to record authorship.
export type AppointmentQueryDirectory = Pick<DirectoryLookup, 'pet' | 'lookup'>;
export type AppointmentListItem = Omit<AppointmentRecord, 'appointmentDate' | 'appointmentTime' | 'internalNote'> & {
  date: string;
  time: string;
  internalNote?: string | null;
  appointmentDate?: undefined;
  appointmentTime?: undefined;
};
export type AppointmentListResult = {
  items: AppointmentListItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  counts: Record<string, number>;
  related: Pick<DirectorySnapshot, 'owners' | 'pets'> & {
    appointments: AppointmentListItem[];
    medicalRecords: unknown[];
    medicalImages: unknown[];
    hotelBookings: unknown[];
    dailyCareNotes: unknown[];
    notifications: unknown[];
    invoices: unknown[];
  };
  directory?: { petId: string; sourceVersion: number; projectionVersion: number; searchReady: boolean };
  searchConsistency?: 'eventual';
};

export interface AppointmentQueries extends AppointmentCalendarQueries {
  list(actor: Actor, directory: AppointmentQueryDirectory, raw: Record<string, unknown>): Promise<AppointmentListResult>;
}
