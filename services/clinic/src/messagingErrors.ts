import { permanentOn } from '@nipopeto/messaging';

// P03: what no retry can heal in Clinic's event consumer. Everything else (Core or
// the database not answering, a timeout) goes through the broker retry ladder.
// A Prisma validation error is a query built wrongly by the code, the same every time.
const prismaValidation = (error: unknown) => error instanceof Error && error.name === 'PrismaClientValidationError';
export const classifyClinicFailure = permanentOn(['UNSUPPORTED_EVENT', 'TERMINAL_CONFLICT'], prismaValidation);
