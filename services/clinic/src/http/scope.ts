import type express from 'express';
import type { ScopeLookup } from '../application/ports/requestScope.js';
import type { Actor } from '../domain/auth.js';
import { authorize, type Permission } from '../domain/authorization.js';
import { BusinessError } from '../domain/error.js';
import { objectInput } from '../domain/validation.js';
import {
  DeferredDirectory,
  RequestDirectory,
  failClosed,
  type CoreDirectory,
} from '../infrastructure/core/directory.js';

// What the URL of a route names, so the pet it belongs to can be found before the handler runs. 'none' is a choice a
// route makes, never a default: a route that omits `resource` does not start.
export type ResourceScope = 'none' | 'appointment' | 'medicalRecord' | 'medicalRecordHistory' | 'medicalImage';
export type ClinicRoute = {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  resource: ResourceScope; // required; the resource id is always req.params.id
  permission?: Permission; // asked before the body is read, for every method (the activity read)
  writePermission?: Permission; // asked before the body is read, when the method is not GET (the medical routes)
  deferred?: true; // a GET list that asks Core once after its query (ADR-P12)
  ignoreQueryPetId?: true; // the query petId is a filter of the activity read, not a pet to authorize
  trimBodyPetId?: true; // POST /medical-records trims a body petId before it goes to Core
  handler: express.RequestHandler;
};

const RESOURCES: readonly string[] = ['none', 'appointment', 'medicalRecord', 'medicalRecordHistory', 'medicalImage'];
const METHODS: readonly string[] = ['get', 'post', 'patch', 'delete'];

// Startup refuses a registry that could leave a route without its scope. index.ts prints only a message made of
// capitals and underscores, so the message is a constant and the route and reason travel in `cause`.
export function assertRoutes(routes: readonly ClinicRoute[]) {
  const seen = new Set<string>();
  for (const route of routes) {
    const name = `${route?.method} ${route?.path}`;
    const refuse = (reason: string): never => {
      throw new Error('CLINIC_ROUTE_SCOPE_REQUIRED', { cause: { route: name, reason } });
    };
    if (!METHODS.includes(route?.method)) refuse('method must be get, post, patch or delete');
    if (typeof route.path !== 'string') refuse('path must be a string');
    if (!RESOURCES.includes(route.resource)) refuse('resource must be none or the kind of resource the URL names');
    if (route.deferred && (route.method !== 'get' || route.resource !== 'none'))
      refuse('deferred is only for a GET route with resource none');
    if (seen.has(name)) refuse('method and path are declared twice');
    seen.add(name);
    if (typeof route.handler !== 'function') refuse('handler must be a function');
  }
}

// `source` is undefined only when createApp was given no Core directory; the authentication middleware then answers 503
// before any route runs, so a PEP never meets it.
export type ScopeDeps = { source: CoreDirectory | undefined; lookup: ScopeLookup };

// The words of sibling routes (`/appointments/calendar`, `/medical-records/images`...) are never a resource id.
const RESERVED_IDS = new Set(['calendar', 'images', 'availability']);

const petOf = (lookup: ScopeLookup, resource: Exclude<ResourceScope, 'none'>, id: string) =>
  resource === 'appointment'
    ? lookup.petOfAppointment(id)
    : resource === 'medicalImage'
      ? lookup.petOfMedicalImage(id)
      : lookup.petOfMedicalRecord(id);

// The policy enforcement point of one route: what is decided from the declaration alone, before the handler runs. It
// refuses by permission, then by the shape of the body, then by the pets and the doctor named, then asks Core once (or,
// for a deferred read, leaves the asking to authorizedRead). The order is the order the requests have always been
// refused in: 403 before 422 before 404 before whatever Core answers.
export function pep(route: ClinicRoute, { source, lookup }: ScopeDeps): express.RequestHandler {
  return async (req, res, next) => {
    const actor = res.locals.actor as Actor;
    if (route.permission) authorize(actor, route.permission);
    if (route.writePermission && req.method !== 'GET') authorize(actor, route.writePermission);
    if (req.body === undefined && ['POST', 'PATCH', 'PUT'].includes(req.method)) req.body = {};
    if (req.body !== undefined) objectInput(req.body);
    const petIds: string[] = [];
    const add = (v: unknown) => {
      if (v !== undefined && v !== null && v !== '') {
        if (typeof v !== 'string' || v.length > 200) throw new BusinessError(422, 'Invalid pet ID.');
        petIds.push(v);
      }
    };
    if (req.method === 'GET') {
      if (!route.ignoreQueryPetId) {
        const id = typeof req.query.petId === 'string' ? req.query.petId.trim() : req.query.petId;
        if (id !== 'all') add(id);
      }
    } else add(route.trimBodyPetId && typeof req.body?.petId === 'string' ? req.body.petId.trim() : req.body?.petId);
    // The resource named in the URL is looked up after the body, so a bad petId is a 422 before an unknown id is a 404.
    if (route.resource !== 'none') {
      const id = String(req.params.id);
      if (!RESERVED_IDS.has(id)) {
        let pet = await petOf(lookup, route.resource, id);
        // AQ-15: history outlives a deleted record; scope it by the pet in its last snapshot.
        if (pet === null && route.resource === 'medicalRecordHistory' && req.method === 'GET')
          pet = await lookup.petOfDeletedRecord(id);
        if (pet === null) throw new BusinessError(404, 'Clinic resource not found.');
        add(pet);
      }
    }
    const token = req.headers.authorization!.slice(7);
    // Deferred authorization: these list GETs query first and ask Core once afterwards (authorizedRead). Every other route, and any state but a closed breaker, asks Core before touching the database.
    if (req.method === 'GET' && route.deferred && req.path === route.path && source!.breaker?.state === 'closed') {
      const directory = new DeferredDirectory(source!, actor, token, [...new Set(petIds)]);
      failClosed(res, directory);
      res.locals.directory = directory;
      next();
      return;
    }
    const snapshot = await source!.request(actor, token, {
      petIds: [...new Set(petIds)],
      ...(req.body?.doctorId ? { doctorId: req.body.doctorId } : {}),
    });
    res.locals.directory = new RequestDirectory(source!, actor, token, snapshot);
    next();
  };
}

export function mountRoutes(router: express.Router, routes: readonly ClinicRoute[], deps: ScopeDeps) {
  assertRoutes(routes);
  for (const route of routes) router[route.method](route.path, pep(route, deps), route.handler);
}
