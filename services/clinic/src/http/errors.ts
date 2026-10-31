import type { ErrorRequestHandler } from 'express';
import { BusinessError, StaleRevision } from '../domain/error.js';
import type { MedicalRecordValue } from '../application/ports/medicalRecords.js';
import { medicalRecordDto } from '../application/serialize.js';
import { DeferredDirectory } from '../infrastructure/core/directory.js';
import { currentRequestId, isTransientFailure, reportUnexpected, requestFault } from '@nipopeto/runtime';

// A stale medical record edit returns the stored record, so the editor can keep its draft and show what changed.
// A deferred read that fails before Core was asked still owes the caller Core's answer: settle first, and a refusal replaces the local error.
export const errorHandler: ErrorRequestHandler = async (error, _req, res, _next) => {
  const directory = res.locals.directory;
  if (directory instanceof DeferredDirectory && !directory.settled)
    try {
      await directory.settle();
    } catch (refusal) {
      error = refusal;
    }
  if (res.headersSent) {
    res.end();
    return;
  }
  const fault = requestFault(error, {
    invalid: 'Invalid JSON.',
    large: 'Request too large.',
    other: 'Request body could not be read.',
  });
  if (error instanceof BusinessError) {
    if (error.status === 503) res.setHeader('Retry-After', '1');
    res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error instanceof StaleRevision ? { current: medicalRecordDto(error.current as MedicalRecordValue) } : {}),
    });
  } else if (fault) res.status(fault.status).json(fault.body);
  else if (error?.code === 'P2025') res.status(404).json({ error: 'Clinic resource not found.' });
  else if (isTransientFailure(error)) {
    res.setHeader('Retry-After', '1');
    res.status(503).json({ error: 'Clinic unavailable. Retry the same request key.' });
  } else res.status(500).json(reportUnexpected('clinic', error, currentRequestId()));
};
