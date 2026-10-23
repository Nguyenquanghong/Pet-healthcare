import type { ApiSchemas } from "./generated/api";

// AQ-07: generated from the OpenAPI contract (types/generated/api.ts).
export type Notification = ApiSchemas["Notification"];
export type NotificationStatus = Notification["status"];
export type NotificationRole = Notification["recipientRole"];
export type NotificationCategory = ApiSchemas["NotificationCategory"];
