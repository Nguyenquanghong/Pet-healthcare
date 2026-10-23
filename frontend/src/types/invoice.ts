import type { ApiSchemas } from "./generated/api";

// AQ-07: generated from the OpenAPI contract (types/generated/api.ts).
export type Invoice = ApiSchemas["Invoice"];
export type InvoiceItem = ApiSchemas["InvoiceItem"];
export type PaymentStatus = Invoice["paymentStatus"];
export type PaymentMethod = NonNullable<Invoice["paymentMethod"]>;
export type BankTransferDetails = ApiSchemas["BankTransferDetails"];
