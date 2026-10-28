import { BusinessError } from './error.js';

export function objectInput(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BusinessError(422, 'Request body must be a JSON object.');
}

export function requiredText(value: unknown, field: string, max = 10_000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new BusinessError(422, `${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

export function optionalText(value: unknown, field: string, max = 10_000): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max)
    throw new BusinessError(422, `${field} must be a string of at most ${max} characters, or null.`);
  return value.trim() || null;
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new BusinessError(422, `${field} must be a boolean.`);
  return value;
}

export function enumValue(value: unknown, field: string, choices: readonly string[]): string {
  if (typeof value !== 'string' || !choices.includes(value)) throw new BusinessError(422, `Invalid ${field}.`);
  return value;
}

// Accept decimal strings used by existing forms, without coercing booleans or null to numbers.
export function positiveNumber(
  value: unknown,
  field: string,
  max: number,
  integer = false,
  decimalPlaces?: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number) || number <= 0 || number > max || (integer && !Number.isInteger(number)))
    throw new BusinessError(
      422,
      `${field} must be a positive ${integer ? 'integer' : 'number'} no greater than ${max}.`,
    );
  if (
    decimalPlaces !== undefined &&
    (Math.round(number * 10 ** decimalPlaces) < 1 ||
      Math.abs(number * 10 ** decimalPlaces - Math.round(number * 10 ** decimalPlaces)) > 1e-8)
  )
    throw new BusinessError(422, `${field} supports at most ${decimalPlaces} decimal places.`);
  return number;
}

export function calendarDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new BusinessError(422, `${field} must be a valid YYYY-MM-DD date.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (value.startsWith('0000-') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new BusinessError(422, `${field} must be a valid YYYY-MM-DD date.`);
  return parsed;
}

// AQ-09: direct clients bypass the browser file picker, so the server checks the
// declared MIME, the data URL prefix and the decoded file signature together.
const imageSignatures: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': bytes => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/gif': bytes => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1')),
  'image/webp': bytes =>
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};
const allowedImageTypes = Object.keys(imageSignatures);

// Returns the decoded bytes once the data URL, MIME type and signature agree.
export function imageContent(imageUrl: string, mimeType: string): Buffer {
  const signature = imageSignatures[mimeType];
  if (!signature) throw new BusinessError(422, `MIME type must be one of ${allowedImageTypes.join(', ')}.`);
  const prefix = `data:${mimeType};base64,`,
    data = imageUrl.slice(prefix.length);
  if (!imageUrl.startsWith(prefix) || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new BusinessError(422, 'Image must be a base64 data URL matching its MIME type.');
  if (!signature(Buffer.from(data.slice(0, 24), 'base64')))
    throw new BusinessError(422, 'Image content does not match its MIME type.');
  return Buffer.from(data, 'base64');
}

export function todayInVietnam(now = Date.now()): string {
  return new Date(now + 7 * 3_600_000).toISOString().slice(0, 10);
}

export function passwordPolicy(password: string): void {
  if (password.length < 8 || password.length > 128)
    throw new BusinessError(422, 'Password must contain 8 to 128 characters.');
}
