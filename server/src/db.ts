import fs from "fs";
import path from "path";

const DATA_FILE = path.join(process.cwd(), "database", "data.json");

export interface DatabaseState {
  users: Array<{
    id: string;
    username?: string;
    phone: string;
    email?: string;
    fullName: string;
    role: "owner" | "doctor" | "staff" | "admin";
    address?: string;
  }>;
  pets: Array<{
    id: string;
    ownerId: string;
    name: string;
    species: "dog" | "cat" | "rabbit" | "other";
    breed?: string;
    gender: "male" | "female" | "unknown";
    ageLabel?: string;
    weightKg?: number;
    microchipId?: string;
    healthStatus: string;
    allergies?: string[];
    notes?: string;
    qrToken?: string;
    createdAt: string;
  }>;
  appointments: Array<{
    id: string;
    petId: string;
    ownerId: string;
    doctorId?: string;
    type: string;
    serviceName: string;
    clinicName: string;
    date: string;
    time: string;
    status: string;
    ownerNote?: string;
    internalNote?: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  }>;
  medicalRecords: Array<{
    id: string;
    petId: string;
    ownerId: string;
    appointmentId?: string;
    doctorName: string;
    visitDate: string;
    title: string;
    symptoms?: string;
    diagnosis?: string;
    treatment?: string;
    medications?: string;
    vaccineName?: string;
    followUpDate?: string;
    weightKg?: number;
    temperatureC?: number;
    heartRateBpm?: number;
    createdAt: string;
    updatedAt: string;
  }>;
  hotelBookings: Array<{
    id: string;
    petId: string;
    ownerId: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    roomType: "standard" | "deluxe" | "vip";
    serviceKeys: string[];
    totalAmount: number;
    status: string;
    ownerNote?: string;
    internalNote?: string;
    dailyCareNoteIds: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  dailyCareNotes: Array<{
    id: string;
    bookingId: string;
    date: string;
    eatingStatus: string;
    mood: string;
    note: string;
    visibleToOwner: boolean;
    createdByStaffId?: string;
    createdAt: string;
  }>;
  notifications: Array<{
    id: string;
    recipientOwnerId?: string;
    recipientRole?: "owner" | "admin";
    type: string;
    title: string;
    message: string;
    status: "sent" | "read";
    actionUrl?: string;
    relatedPetId?: string;
    relatedAppointmentId?: string;
    relatedBookingId?: string;
    createdAt: string;
    sentAt: string;
  }>;
  invoices: Array<{
    id: string;
    invoiceCode: string;
    type: "appointment" | "hotel_booking";
    ownerId: string;
    petId: string;
    appointmentId?: string;
    hotelBookingId?: string;
    subtotal: number;
    taxAmount: number;
    discountAmount: number;
    totalAmount: number;
    paymentStatus: "paid" | "unpaid" | "refunded";
    paymentMethod?: string;
    issuedAt: string;
    paidAt?: string;
    notes?: string;
    items: Array<{
      id: string;
      description: string;
      unitPrice: number;
      quantity: number;
      amount: number;
    }>;
  }>;
}

const now = new Date().toISOString();

const initialSeedData: DatabaseState = {
  users: [
    {
      id: "owner_1",
      phone: "0901234567",
      email: "owner@example.com",
      fullName: "Nguyễn Văn A",
      role: "owner",
      address: "Mỹ Đình, Nam Từ Liêm, Hà Nội",
    },
    {
      id: "doctor_mai",
      username: "dr.mai",
      phone: "0912345678",
      fullName: "Bs. Mai Nguyễn",
      role: "doctor",
      address: "Bệnh viện Thú y Mỹ Đình",
    },
    {
      id: "staff_admin",
      username: "admin",
      phone: "0999888777",
      fullName: "Admin Quản Trị",
      role: "admin",
    },
  ],
  pets: [
    {
      id: "pet_mochi",
      ownerId: "owner_1",
      name: "Mochi",
      species: "dog",
      breed: "Shiba Inu",
      gender: "male",
      ageLabel: "2 tuổi",
      weightKg: 8.4,
      microchipId: "JP-2026-MOCHI",
      healthStatus: "healthy",
      allergies: ["Không"],
      createdAt: now,
    },
    {
      id: "pet_yuki",
      ownerId: "owner_1",
      name: "Yuki",
      species: "dog",
      breed: "Shiba Inu",
      gender: "female",
      ageLabel: "1 tuổi",
      weightKg: 7.2,
      microchipId: "JP-2026-YUKI",
      healthStatus: "stable",
      allergies: ["Thịt bò"],
      createdAt: now,
    },
  ],
  appointments: [
    {
      id: "appointment_1",
      petId: "pet_mochi",
      ownerId: "owner_1",
      doctorId: "doctor_mai",
      type: "general_checkup",
      serviceName: "Khám tổng quát",
      clinicName: "Bệnh viện Thú y Mỹ Đình",
      date: "2026-11-02",
      time: "09:00",
      status: "confirmed",
      createdBy: "owner",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "appointment_2",
      petId: "pet_yuki",
      ownerId: "owner_1",
      type: "vaccination",
      serviceName: "Tiêm phòng dại & 7 bệnh",
      clinicName: "Bệnh viện Thú y Mỹ Đình",
      date: "2026-11-03",
      time: "10:30",
      status: "pending",
      ownerNote: "Ưu tiên buổi sáng",
      createdBy: "owner",
      createdAt: now,
      updatedAt: now,
    },
  ],
  medicalRecords: [
    {
      id: "record_1",
      petId: "pet_mochi",
      ownerId: "owner_1",
      appointmentId: "appointment_1",
      doctorName: "Bs. Mai Nguyễn",
      visitDate: "2026-10-28",
      title: "Annual Checkup & Vaccination",
      symptoms: "Khám định kỳ, không có triệu chứng bất thường.",
      diagnosis: "Sức khỏe ổn định, cân nặng phù hợp.",
      treatment: "Tiêm vaccine nhắc lại và tư vấn dinh dưỡng.",
      medications: "Vitamin tổng hợp 7 ngày",
      vaccineName: "DHPPi + Lepto",
      followUpDate: "2027-04-28",
      weightKg: 8.4,
      temperatureC: 38.2,
      heartRateBpm: 92,
      createdAt: now,
      updatedAt: now,
    },
  ],
  hotelBookings: [
    {
      id: "booking_1",
      petId: "pet_yuki",
      ownerId: "owner_1",
      checkIn: "2026-11-10",
      checkOut: "2026-11-13",
      nights: 3,
      roomType: "deluxe",
      serviceKeys: ["special_diet"],
      totalAmount: 20100,
      status: "pending",
      ownerNote: "Yuki cần chế độ ăn ít muối.",
      dailyCareNoteIds: [],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "booking_2",
      petId: "pet_mochi",
      ownerId: "owner_1",
      checkIn: "2026-11-18",
      checkOut: "2026-11-20",
      nights: 2,
      roomType: "standard",
      serviceKeys: ["daily_walk"],
      totalAmount: 7600,
      status: "in_stay",
      dailyCareNoteIds: ["note_1"],
      createdAt: now,
      updatedAt: now,
    },
  ],
  dailyCareNotes: [
    {
      id: "note_1",
      bookingId: "booking_2",
      date: "2026-11-19",
      eatingStatus: "good",
      mood: "happy",
      note: "Bé Mochi hôm nay ăn ngon miệng, đi dạo 30 phút trong sân vườn và rất hợp tác.",
      visibleToOwner: true,
      createdByStaffId: "staff_admin",
      createdAt: now,
    },
  ],
  notifications: [
    {
      id: "noti_1",
      recipientOwnerId: "owner_1",
      recipientRole: "owner",
      type: "appointment_reminder",
      title: "Nhắc lịch khám",
      message: "Mochi có lịch khám vào 09:00 ngày mai tại Bệnh viện Thú y Mỹ Đình.",
      status: "sent",
      actionUrl: "/owner/appointments",
      relatedPetId: "pet_mochi",
      relatedAppointmentId: "appointment_1",
      createdAt: now,
      sentAt: now,
    },
  ],
  invoices: [
    {
      id: "inv_1",
      invoiceCode: "INV-APP-2026-001",
      type: "appointment",
      ownerId: "owner_1",
      petId: "pet_mochi",
      appointmentId: "appointment_1",
      subtotal: 250000,
      taxAmount: 20000,
      discountAmount: 0,
      totalAmount: 270000,
      paymentStatus: "paid",
      paymentMethod: "credit_card",
      issuedAt: "2026-11-02",
      paidAt: "2026-11-02",
      items: [
        {
          id: "item_1",
          description: "Khám tổng quát & Tư vấn dinh dưỡng (Mochi)",
          unitPrice: 250000,
          quantity: 1,
          amount: 250000,
        },
      ],
    },
  ],
};

class Database {
  private state: DatabaseState;

  constructor() {
    this.state = this.load();
  }

  private load(): DatabaseState {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, "utf-8");
        return JSON.parse(raw);
      }
    } catch {
      // fallback
    }
    this.save(initialSeedData);
    return initialSeedData;
  }

  private save(data: DatabaseState) {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.error("Lỗi ghi database file:", e);
    }
  }

  public get(): DatabaseState {
    return this.state;
  }

  public update(updater: (draft: DatabaseState) => void) {
    updater(this.state);
    this.save(this.state);
  }
}

export const db = new Database();
