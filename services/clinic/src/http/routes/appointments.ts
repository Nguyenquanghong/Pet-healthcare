import type { Request, Response } from 'express';
import { appointmentDto } from '../../application/serialize.js';
import type { Tx, UseCases } from '../../infrastructure/useCases.js';
import { authorizedRead, read, sendMutation } from '../respond.js';
import type { ClinicRoute } from '../scope.js';
import { normalizeCreate } from './normalizeCreate.js';

const appointment = (useCases: UseCases, res: Response, bound?: Tx) =>
  useCases.appointment(res.locals.directory, bound);
const change = async (
  useCases: UseCases,
  req: Request,
  res: Response,
  action: 'changeStatus' | 'reschedule' | 'cancel' | 'undoStatus',
) => {
  const result = await useCases.transaction(async tx => {
    const row = await appointment(useCases, res, tx)[action](res.locals.actor, String(req.params.id), req.body ?? {});
    return { appointment: appointmentDto(row, res.locals.actor) };
  });
  sendMutation(res, result);
};

// One element per route: what its URL names (resource), the permissions asked before the body is read, and its handler.
export const appointmentRoutes = (useCases: UseCases): ClinicRoute[] => [
  {
    method: 'get',
    path: '/appointments',
    resource: 'none',
    deferred: true,
    handler: async (req, res) =>
      authorizedRead(res, () =>
        read(useCases.appointmentReads, reader => reader.list(res.locals.actor, res.locals.directory, req.query), res),
      ),
  },
  {
    method: 'get',
    path: '/appointments/calendar',
    resource: 'none',
    handler: async (req, res) =>
      res.json(
        await read(
          useCases.appointmentReads,
          reader => reader.calendar(res.locals.actor, { month: req.query.month, category: req.query.category }),
          res,
        ),
      ),
  },
  {
    method: 'get',
    path: '/appointments/availability',
    resource: 'none',
    handler: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await appointment(useCases, res).availability(res.locals.actor, req.query));
    },
  },
  {
    method: 'post',
    path: '/appointments',
    resource: 'none',
    handler: async (req, res) => {
      const result = await useCases.createOnce(
        res.locals.actor.sub,
        'appointment.create',
        req.headers['idempotency-key'],
        normalizeCreate(req.body, false),
        async tx => {
          const row = await appointment(useCases, res, tx).create(res.locals.actor, req.body);
          return { resourceId: row.id, response: { appointment: appointmentDto(row, res.locals.actor) } };
        },
      );
      sendMutation(res, result, 201);
    },
  },
  {
    method: 'patch',
    path: '/appointments/:id/status',
    resource: 'appointment',
    handler: async (req, res) => change(useCases, req, res, 'changeStatus'),
  },
  {
    method: 'patch',
    path: '/appointments/:id/reschedule',
    resource: 'appointment',
    handler: async (req, res) => change(useCases, req, res, 'reschedule'),
  },
  {
    method: 'patch',
    path: '/appointments/:id/cancel',
    resource: 'appointment',
    handler: async (req, res) => change(useCases, req, res, 'cancel'),
  },
  {
    method: 'get',
    path: '/appointments/:id/status-history',
    resource: 'appointment',
    handler: async (req, res) =>
      res.json(await appointment(useCases, res).history(res.locals.actor, String(req.params.id))),
  },
  {
    method: 'post',
    path: '/appointments/:id/undo-status',
    resource: 'appointment',
    handler: async (req, res) => change(useCases, req, res, 'undoStatus'),
  },
  {
    method: 'post',
    path: '/appointments/:id/reminder',
    resource: 'appointment',
    handler: async (req, res) => {
      await appointment(useCases, res).sendReminder(res.locals.actor, String(req.params.id));
      res.status(201).json({ message: 'Reminder request accepted.' });
    },
  },
];
