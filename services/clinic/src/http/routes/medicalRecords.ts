import type { Response } from 'express';
import { medicalRecordDto } from '../../application/serialize.js';
import type { Tx, UseCases } from '../../infrastructure/useCases.js';
import { authorizedRead, sendMutation } from '../respond.js';
import type { ClinicRoute } from '../scope.js';
import { normalizeCreate } from './normalizeCreate.js';

const medical = (useCases: UseCases, res: Response, bound?: Tx) => useCases.medical(res.locals.directory, bound);

// One element per route: what its URL names (resource), the permissions asked before the body is read, and its handler.
export const medicalRecordRoutes = (useCases: UseCases): ClinicRoute[] => [
  {
    method: 'get',
    path: '/medical-records',
    resource: 'none',
    writePermission: 'medical-record.write',
    deferred: true,
    handler: async (req, res) =>
      authorizedRead(res, () => useCases.list('medicalRecords', res.locals.actor, res.locals.directory, req.query)),
  },
  {
    method: 'post',
    path: '/medical-records',
    resource: 'none',
    writePermission: 'medical-record.write',
    trimBodyPetId: true,
    handler: async (req, res) => {
      const result = await useCases.createOnce(
        res.locals.actor.sub,
        'medical-record.create',
        req.headers['idempotency-key'],
        normalizeCreate(req.body, true),
        async tx => {
          const row = await medical(useCases, res, tx).create(res.locals.actor, req.body);
          return { resourceId: row.id, response: { record: medicalRecordDto(row) } };
        },
      );
      sendMutation(res, result, 201);
    },
  },
  {
    method: 'patch',
    path: '/medical-records/:id',
    resource: 'medicalRecord',
    writePermission: 'medical-record.write',
    handler: async (req, res) =>
      res.json({
        record: medicalRecordDto(
          await useCases.medicalMutation(String(req.params.id), tx =>
            medical(useCases, res, tx).update(res.locals.actor, String(req.params.id), req.body ?? {}),
          ),
        ),
      }),
  },
  {
    method: 'delete',
    path: '/medical-records/:id',
    resource: 'medicalRecord',
    writePermission: 'medical-record.write',
    handler: async (req, res) => {
      await useCases.medicalMutation(String(req.params.id), tx =>
        medical(useCases, res, tx).delete(res.locals.actor, String(req.params.id), req.query.expectedRevision),
      );
      res.status(204).end();
    },
  },
  {
    method: 'get',
    path: '/medical-records/:id/history',
    resource: 'medicalRecordHistory',
    writePermission: 'medical-record.write',
    handler: async (req, res) =>
      res.json({ items: await medical(useCases, res).history(res.locals.actor, String(req.params.id)) }),
  },
  {
    method: 'get',
    path: '/medical-records/images',
    resource: 'none',
    writePermission: 'medical-record.write',
    deferred: true,
    handler: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      await authorizedRead(res, () =>
        useCases.list('medicalImages', res.locals.actor, res.locals.directory, req.query),
      );
    },
  },
  {
    method: 'post',
    path: '/medical-records/images',
    resource: 'none',
    writePermission: 'medical-record.write',
    handler: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ image: await medical(useCases, res).createImage(res.locals.actor, req.body) });
    },
  },
  {
    method: 'delete',
    path: '/medical-records/images/:id',
    resource: 'medicalImage',
    writePermission: 'medical-record.write',
    handler: async (req, res) => {
      await medical(useCases, res).deleteImage(res.locals.actor, String(req.params.id));
      res.status(204).end();
    },
  },
  {
    method: 'post',
    path: '/medical-records/images/:id/restore',
    resource: 'medicalImage',
    writePermission: 'medical-record.write',
    handler: async (req, res) => {
      await medical(useCases, res).restoreImage(res.locals.actor, String(req.params.id));
      res.status(204).end();
    },
  },
];
