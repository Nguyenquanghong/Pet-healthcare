import type { Role } from '../../domain/auth.js';

export type SendAccount = { id: string; role: Role };

export interface SendAccountReader {
  find(id: string): Promise<SendAccount | null>;
}
