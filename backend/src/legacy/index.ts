// The one door into the Phase 1 clinical stack. Composition mounts it only where the process serves clinical routes itself.
export { AppointmentService } from './application/services/appointments.js';
export { MedicalRecordsService } from './application/services/medicalRecords.js';
export { NotificationsService } from './application/services/notifications.js';
export { createAppointmentDependencies } from './infrastructure/persistence/appointmentRepository.js';
export { PrismaAppointmentLifecycleStore } from './infrastructure/persistence/appointmentLifecycleStore.js';
export { appointmentInvoiceSource } from './infrastructure/persistence/clinicalSources.js';
export { createMedicalDependencies } from './infrastructure/persistence/medicalRepository.js';
export { PrismaNotificationRepository } from './infrastructure/persistence/notificationRepository.js';
export { createAppointmentsRouter } from './routes/appointments.js';
export { createBootstrapRouter } from './routes/bootstrap.js';
export { createMedicalRecordsRouter } from './routes/medicalRecords.js';
export { createNotificationsRouter } from './routes/notifications.js';
