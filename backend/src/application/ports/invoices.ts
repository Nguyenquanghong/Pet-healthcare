export type InvoiceValue = {
  id: string; invoiceCode: string; type: string; ownerId: string; petId: string;
  appointmentId: string | null; hotelBookingId: string | null;
  subtotal: number | { toString(): string }; taxAmount: number | { toString(): string };
  discountAmount: number | { toString(): string }; totalAmount: number | { toString(): string };
  paymentStatus: string; paymentMethod: string | null; issuedAt: Date; paidAt: Date | null;
  notes: string | null; createdAt: Date; updatedAt: Date;
  paymentChannel: string | null;
  transferCode?: string | null;
  bankTransferDetails?: unknown;
  transferReviewStatus?: string | null; transferReportedAt?: Date | null;
  transferReference?: string | null; transferReviewNote?: string | null;
  items?: { id: string; description: string; unitPrice: number | { toString(): string }; quantity: number; amount: number | { toString(): string } }[];
};

export type InvoiceType = "appointment" | "hotel_booking";
export type BankTransferDetails = { bankName: string; bankBin?: string; accountNumber: string; accountHolder: string; isDemo: boolean };
export interface TransferQrGenerator {
  generate(details: unknown, amount: number, content: string): Promise<string>;
}
export type InvoiceSource = { ownerId: string; petId: string; status: string; description: string; amount?: number; serviceType?: string };
export type InvoiceLine = { description: string; quantity: number; unitPrice: number; amount: number };
export type InvoiceCreateData = {
  type: InvoiceType; ownerId: string; petId: string; appointmentId: string | null; hotelBookingId: string | null;
  subtotal: number; taxAmount: number; discountAmount: number; totalAmount: number; notes: string | null;
  items: InvoiceLine[];
};
export type InvoiceNotice = { recipientOwnerId?: string; recipientRole: string; type: string; title: string; message: string; actionUrl: string };
export interface InvoiceIssuance {
  source(type: InvoiceType, id: string): Promise<InvoiceSource | null>;
  findSource(type: InvoiceType, id: string): Promise<InvoiceValue | null>;
  create(data: InvoiceCreateData): Promise<InvoiceValue>;
  notify(data: InvoiceNotice): Promise<void>;
}


export interface InvoiceRepository {
  list(ownerId?: string): Promise<InvoiceValue[]>;
  find(id: string, ownerId?: string): Promise<InvoiceValue | null>;
  pay(id: string, paymentMethod: string, paidAt: Date): Promise<InvoiceValue>;
  issue<T>(work: (transaction: InvoiceIssuance) => Promise<T>): Promise<T>;
  chooseOnsite(id: string, ownerId: string): Promise<InvoiceValue>;
  chooseTransfer(id: string, ownerId: string, details: BankTransferDetails): Promise<InvoiceValue>;
  reportTransfer(id: string, ownerId: string, reference: string | null): Promise<InvoiceValue>;
  rejectTransfer(id: string, reason: string): Promise<InvoiceValue>;
}
