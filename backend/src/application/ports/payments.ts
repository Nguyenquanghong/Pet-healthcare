export type PaymentAttemptValue = { id: string; invoiceId: string; amount: number | { toString(): string }; status: string; createdAt: Date; expiresAt: Date };
export type PaymentResult = { reference: string; amount: number; success: boolean; transactionNo: string; responseCode: string };
export type IpnReply = { RspCode: string; Message: string };
export interface PaymentGateway {
  enabled(): boolean;
  url(attempt: PaymentAttemptValue, ip: string): string;
  verify(query: Record<string, unknown>): PaymentResult | null;
  query(attempt: PaymentAttemptValue, ip: string): Promise<PaymentResult | null>;
}
export interface PaymentRepository {
  prepare(invoiceId: string, ownerId: string): Promise<PaymentAttemptValue>;
  confirm(result: PaymentResult): Promise<IpnReply>;
  latest(invoiceId: string, ownerId?: string): Promise<PaymentAttemptValue>;
}
