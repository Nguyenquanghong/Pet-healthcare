-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('general_checkup', 'vaccination', 'dental', 'dermatology', 'surgery', 'hotel_consultation', 'spa_bath', 'spa_grooming', 'spa_combo', 'other');

-- AlterTable
ALTER TABLE "DirectoryProjection" ADD COLUMN     "breed" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "microchipId" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "pet_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "doctor_id" TEXT,
    "type" "AppointmentType" NOT NULL,
    "service_name" TEXT NOT NULL,
    "clinic_name" TEXT NOT NULL,
    "appointment_date" DATE NOT NULL,
    "appointment_time" TEXT NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'pending',
    "status_revision" INTEGER NOT NULL DEFAULT 0,
    "owner_note" TEXT,
    "internal_note" TEXT,
    "created_by" TEXT NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_records" (
    "id" TEXT NOT NULL,
    "pet_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "appointment_id" TEXT,
    "doctor_name" TEXT NOT NULL,
    "visit_date" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "symptoms" TEXT,
    "diagnosis" TEXT NOT NULL,
    "treatment" TEXT NOT NULL,
    "medications" TEXT,
    "vaccine_name" TEXT,
    "follow_up_date" DATE,
    "weight_kg" DECIMAL(5,2),
    "temperature_c" DECIMAL(4,1),
    "heart_rate_bpm" INTEGER,
    "internal_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_images" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "pet_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_status_events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_name" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "reason" TEXT,
    "reverses_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentReservation" (
    "operationId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "revisionAtPrepare" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'HELD',
    "invoiceId" TEXT,

    CONSTRAINT "AppointmentReservation_pkey" PRIMARY KEY ("operationId")
);

-- CreateTable
CREATE TABLE "RequestDedup" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "responsePayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestDedup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointments_owner_id_appointment_date_idx" ON "appointments"("owner_id", "appointment_date");

-- CreateIndex
CREATE INDEX "appointments_page_idx" ON "appointments"("status", "appointment_date" DESC, "appointment_time" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "appointments_owner_page_idx" ON "appointments"("owner_id", "status", "appointment_date" DESC, "appointment_time" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "medical_records_pet_id_visit_date_idx" ON "medical_records"("pet_id", "visit_date");

-- CreateIndex
CREATE INDEX "medical_records_owner_page_idx" ON "medical_records"("owner_id", "visit_date", "id");

-- CreateIndex
CREATE INDEX "medical_records_page_idx" ON "medical_records"("visit_date", "id");

-- CreateIndex
CREATE INDEX "medical_images_pet_id_idx" ON "medical_images"("pet_id");

-- CreateIndex
CREATE INDEX "medical_images_pet_page_idx" ON "medical_images"("pet_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "medical_images_owner_page_idx" ON "medical_images"("owner_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_status_events_reverses_id_key" ON "booking_status_events"("reverses_id");

-- CreateIndex
CREATE INDEX "booking_status_events_booking_idx" ON "booking_status_events"("kind", "booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "booking_status_events_kind_booking_id_revision_key" ON "booking_status_events"("kind", "booking_id", "revision");

-- CreateIndex
CREATE INDEX "AppointmentReservation_appointmentId_state_idx" ON "AppointmentReservation"("appointmentId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "RequestDedup_actorId_operationType_key_key" ON "RequestDedup"("actorId", "operationType", "key");

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_status_events" ADD CONSTRAINT "booking_status_events_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "booking_status_events"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "booking_status_events" ADD CONSTRAINT "booking_status_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT "AppointmentReservation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exam and Spa share the same pet/date/time invariant on every replica.
CREATE UNIQUE INDEX appointments_active_pet_slot_key ON appointments(pet_id,appointment_date,appointment_time)
  WHERE status NOT IN ('cancelled','no_show');
ALTER TABLE appointments ADD CONSTRAINT appointments_revision_valid CHECK(status_revision>=0),
  ADD CONSTRAINT appointments_time_valid CHECK(appointment_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE booking_status_events ADD CONSTRAINT clinic_history_kind CHECK(kind='appointment');
ALTER TABLE "AppointmentReservation" ADD CONSTRAINT clinic_reservation_state CHECK(state IN ('HELD','INVOICED','RELEASED'));
CREATE UNIQUE INDEX clinic_active_reservation ON "AppointmentReservation"("appointmentId") WHERE state IN ('HELD','INVOICED');
