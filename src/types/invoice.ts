export type PaymentStatus = "paid" | "unpaid" | "refunded";
export type PaymentMethod = "cash" | "bank_transfer" | "credit_card";

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
  type: "appointment" | "hotel_booking";
  ownerId: string;
  petId: string;
  relatedId?: string; // appointmentId or bookingId
  items: InvoiceItem[];
  subtotal: number;
  taxAmount: number; // 8% or 10%
  discountAmount: number;
  totalAmount: number;
  paymentStatus: PaymentStatus;
  paymentMethod?: PaymentMethod;
  issuedAt: string;
  paidAt?: string;
  notes?: string;
};
