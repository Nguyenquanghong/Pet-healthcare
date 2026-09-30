export type PaymentStatus = "paid" | "unpaid" | "refunded";
export type PaymentMethod = "cash" | "bank_transfer" | "credit_card" | "qr_code" | "vnpay";
export type BankTransferDetails = { bankName: string; bankBin?: string; accountNumber: string; accountHolder: string; isDemo: boolean };

export type InvoiceItem = {
  id: string;
  description: string;
  unitPrice: number;
  quantity: number;
  amount: number;
};

export type Invoice = {
  id: string;
  invoiceCode: string; // e.g. INV-2026-001
  transferContent: string;
  type: "appointment" | "hotel_booking";
  ownerId: string;
  petId: string;
  relatedId?: string; // appointmentId or bookingId
  appointmentId?: string | null;
  hotelBookingId?: string | null;
  items: InvoiceItem[];
  subtotal: number;
  taxAmount: number; // 8% or 10%
  discountAmount: number;
  totalAmount: number;
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethod | null;
  paymentChannel?: "online" | "onsite" | "bank_transfer" | null;
  bankTransferDetails?: BankTransferDetails | null;
  transferReviewStatus?: "pending" | "rejected" | "confirmed" | null;
  transferReportedAt?: string | null;
  transferReference?: string | null;
  transferReviewNote?: string | null;
  issuedAt: string;
  paidAt?: string | null;
  notes?: string | null;
};
