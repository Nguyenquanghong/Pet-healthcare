BEGIN;
-- CreateEnum
CREATE TYPE "ReadGenerationState" AS ENUM ('BUILDING', 'READY', 'ACTIVE', 'RETIRED');

-- CreateTable
CREATE TABLE "ClinicReadRevision" (
    "kind" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicReadRevision_pkey" PRIMARY KEY ("kind","aggregateId")
);

-- CreateTable
CREATE TABLE "ReadProjectionGeneration" (
    "id" TEXT NOT NULL,
    "projectionName" TEXT NOT NULL DEFAULT 'appointments',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "state" "ReadGenerationState" NOT NULL DEFAULT 'BUILDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "ReadProjectionGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadProjectionControl" (
    "projectionName" TEXT NOT NULL,
    "activeGenerationId" TEXT,
    "servingMode" TEXT NOT NULL DEFAULT 'authoritative',

    CONSTRAINT "ReadProjectionControl_pkey" PRIMARY KEY ("projectionName")
);

-- CreateTable
CREATE TABLE "AppointmentReadRow" (
    "generation" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "petId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "doctorId" TEXT,
    "type" "AppointmentType" NOT NULL,
    "serviceName" TEXT NOT NULL,
    "clinicName" TEXT NOT NULL,
    "appointmentDate" DATE NOT NULL,
    "appointmentTime" TEXT NOT NULL,
    "status" "AppointmentStatus" NOT NULL,
    "statusRevision" INTEGER NOT NULL,
    "ownerNote" TEXT,
    "internalNote" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "billingHeld" BOOLEAN NOT NULL,
    "billingInvoiced" BOOLEAN NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "projectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentReadRow_pkey" PRIMARY KEY ("generation","appointmentId")
);

-- AddForeignKey
ALTER TABLE "ReadProjectionControl" ADD CONSTRAINT "ReadProjectionControl_activeGenerationId_fkey" FOREIGN KEY ("activeGenerationId") REFERENCES "ReadProjectionGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentReadRow" ADD CONSTRAINT "AppointmentReadRow_generation_fkey" FOREIGN KEY ("generation") REFERENCES "ReadProjectionGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ClinicReadRevision" ADD CONSTRAINT "read_revision_positive" CHECK (version>=1);
ALTER TABLE "AppointmentReadRow" ADD CONSTRAINT "read_row_version_positive" CHECK ("sourceVersion">=1);
COMMIT;
