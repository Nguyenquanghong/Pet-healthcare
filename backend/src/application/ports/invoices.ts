export type InvoiceValue = {
  id: string; invoiceCode: string; type: string; ownerId: string; petId: string;
  appointmentId: string | null; hotelBookingId: string | null;
  subtotal: number | { toString(): string }; taxAmount: number | { toString(): string };
  discountAmount: number | { toString(): string }; totalAmount: number | { toString(): string };
  paymentStatus: string; paymentMethod: string | null; issuedAt: Date; paidAt: Date | null;
  notes: string | null; createdAt: Date; updatedAt: Date; items?: unknown[];
};

export interface InvoiceRepository {
  list(ownerId?: string): Promise<InvoiceValue[]>;
  pay(id: string, paymentMethod: string, paidAt: Date): Promise<InvoiceValue>;
}
