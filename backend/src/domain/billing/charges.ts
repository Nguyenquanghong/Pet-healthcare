import type { BillingSourceSnapshot } from '@nipopeto/contracts';
import { BusinessError } from '../error.js';
import pricing from '../pricing.json' with { type: 'json' };

export type InvoiceLine = { description: string; quantity: number; unitPrice: number; amount: number };

// The order of the keys is part of the request hash (JSON.stringify of fees()); reordering them makes every
// retry that is still running answer 409 "different charges".
export type Fees = {
  relatedId: string;
  items?: InvoiceLine[];
  subtotal?: number;
  taxAmount: number;
  discountAmount: number;
  notes: string | null;
  expectedRevision?: number;
};

export function money(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999)
    throw new BusinessError(422, `${name} phải là số tiền VND nguyên, không âm và không quá 9.999.999.999.`);
  return value;
}
export function lines(value: unknown): InvoiceLine[] {
  if (!Array.isArray(value) || value.length > 50) throw new BusinessError(422, 'Tối đa 50 dòng dịch vụ.');
  return value.map(raw => {
    if (!raw || typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 300)
      throw new BusinessError(422, 'Mỗi dòng cần mô tả dịch vụ (tối đa 300 ký tự).');
    if (!Number.isSafeInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > 10000)
      throw new BusinessError(422, 'Số lượng phải từ 1 đến 10.000.');
    const unitPrice = money(raw.unitPrice, 'Đơn giá');
    return {
      description: raw.description.trim(),
      unitPrice,
      quantity: raw.quantity,
      amount: money(unitPrice * raw.quantity, 'Thành tiền'),
    };
  });
}
export function fees(input: Record<string, unknown>, self: boolean): Fees {
  if (
    !input ||
    Array.isArray(input) ||
    input.type !== 'appointment' ||
    typeof input.relatedId !== 'string' ||
    !input.relatedId.trim() ||
    input.relatedId.length > 128
  )
    throw new BusinessError(422, 'Invalid appointment billing source.');
  if (self && Object.keys(input).some(k => !['type', 'relatedId'].includes(k)))
    throw new BusinessError(422, 'Prices are calculated by the server.');
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 2000))
    throw new BusinessError(422, 'Invalid invoice notes.');
  if (
    input.expectedRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedRevision) ||
      Number(input.expectedRevision) < 0 ||
      Number(input.expectedRevision) > 2147483647)
  )
    throw new BusinessError(422, 'Invalid source revision.');
  return {
    relatedId: input.relatedId.trim(),
    ...(!self
      ? input.items === undefined
        ? { subtotal: money(input.subtotal, 'Subtotal') }
        : { items: lines(input.items) }
      : {}),
    taxAmount: money(input.taxAmount ?? 0, 'Tax'),
    discountAmount: money(input.discountAmount ?? 0, 'Discount'),
    notes: typeof input.notes === 'string' ? input.notes.trim() || null : null,
    ...(input.expectedRevision !== undefined ? { expectedRevision: Number(input.expectedRevision) } : {}),
  };
}
export function charges(input: Fees, s: BillingSourceSnapshot, self: boolean) {
  const rate = pricing.fixedSpaRates[s.type as keyof typeof pricing.fixedSpaRates];
  if (self && !rate) throw new BusinessError(409, 'This service requires staff to settle charges.');
  const items = self
    ? [{ description: s.serviceName, quantity: 1, unitPrice: rate!, amount: rate! }]
    : (input.items ?? [
        { description: s.serviceName, quantity: 1, unitPrice: input.subtotal!, amount: input.subtotal! },
      ]);
  if (!items.length) throw new BusinessError(422, 'Invoice requires at least one service.');
  const subtotal = money(
    items.reduce((n, l) => n + l.amount, 0),
    'Subtotal',
  );
  if (input.discountAmount > subtotal) throw new BusinessError(422, 'Discount exceeds subtotal.');
  const totalAmount = money(subtotal + input.taxAmount - input.discountAmount, 'Total');
  if (totalAmount <= 0) throw new BusinessError(422, 'Invoice total must be positive.');
  return {
    items,
    subtotal,
    taxAmount: input.taxAmount,
    discountAmount: input.discountAmount,
    totalAmount,
    notes: input.notes,
  };
}
