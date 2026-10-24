import { permanentOn } from '@nipopeto/messaging';

// P03: what no retry can heal in Notification's consumers. Everything else (the
// database not answering, a timeout) goes through the broker retry ladder.
// A Prisma validation error is a query built wrongly by the code, the same every time.
const prismaValidation = (error: unknown) => error instanceof Error && error.name === 'PrismaClientValidationError';
export const classifyNotificationFailure = permanentOn(['UNSUPPORTED_EVENT'], prismaValidation);
