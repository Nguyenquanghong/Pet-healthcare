import type { Appointment, AppointmentStatus, AppointmentType } from "../types/appointment";
import type { DailyCareNote, HotelBooking, HotelBookingStatus } from "../types/booking";
import type { MedicalRecord } from "../types/medicalRecord";
import type { Notification } from "../types/notification";
import type { Owner } from "../types/owner";
import type { Pet } from "../types/pet";

const MOCK_DELAY_MS = 200;

function delay<T>(value: T, ms = MOCK_DELAY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export const mockApi = {
  auth: {
    loginOwner: async (phone: string): Promise<{ success: boolean; phone: string }> => {
      return delay({ success: true, phone });
    },
    loginAdmin: async (username: string): Promise<{ success: boolean; username: string }> => {
      return delay({ success: true, username });
    },
    registerOwner: async (owner: Omit<Owner, "id" | "petIds">): Promise<{ success: boolean; data: typeof owner }> => {
      return delay({ success: true, data: owner });
    },
  },

  pets: {
    getPets: async (pets: Pet[]): Promise<Pet[]> => {
      return delay(pets);
    },
    createPet: async (pet: Omit<Pet, "id" | "ownerId">): Promise<typeof pet> => {
      return delay(pet);
    },
    updatePet: async (petId: string, input: Partial<Pet>): Promise<{ petId: string; input: typeof input }> => {
      return delay({ petId, input });
    },
  },

  appointments: {
    getAppointments: async (appointments: Appointment[]): Promise<Appointment[]> => {
      return delay(appointments);
    },
    createAppointment: async (input: { petId: string; serviceName: string; date: string; time: string }): Promise<typeof input> => {
      return delay(input);
    },
    updateStatus: async (id: string, status: AppointmentStatus): Promise<{ id: string; status: AppointmentStatus }> => {
      return delay({ id, status });
    },
  },

  medicalRecords: {
    getRecords: async (records: MedicalRecord[]): Promise<MedicalRecord[]> => {
      return delay(records);
    },
    createRecord: async (input: Omit<MedicalRecord, "id" | "ownerId" | "createdAt" | "updatedAt">): Promise<typeof input> => {
      return delay(input);
    },
    updateRecord: async (recordId: string, input: Partial<MedicalRecord>): Promise<{ recordId: string; input: typeof input }> => {
      return delay({ recordId, input });
    },
    deleteRecord: async (recordId: string): Promise<{ recordId: string; success: boolean }> => {
      return delay({ recordId, success: true });
    },
  },

  hotel: {
    getBookings: async (bookings: HotelBooking[]): Promise<HotelBooking[]> => {
      return delay(bookings);
    },
    createBooking: async (input: { petId: string; checkIn: string; checkOut: string }): Promise<typeof input> => {
      return delay(input);
    },
    updateStatus: async (id: string, status: HotelBookingStatus): Promise<{ id: string; status: HotelBookingStatus }> => {
      return delay({ id, status });
    },
    addCareNote: async (note: DailyCareNote): Promise<DailyCareNote> => {
      return delay(note);
    },
  },

  notifications: {
    getNotifications: async (notifications: Notification[]): Promise<Notification[]> => {
      return delay(notifications);
    },
    markRead: async (id: string): Promise<{ id: string; success: boolean }> => {
      return delay({ id, success: true });
    },
    deleteNotification: async (id: string): Promise<{ id: string; success: boolean }> => {
      return delay({ id, success: true });
    },
  },

  system: {
    resetData: async (): Promise<{ success: boolean }> => {
      localStorage.removeItem("niponeto_app_state");
      return delay({ success: true }, 300);
    },
  },
};
