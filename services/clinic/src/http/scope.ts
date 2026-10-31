import type express from 'express';
import type { Permission } from '../domain/authorization.js';

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

export function mountRoutes(router: express.Router, routes: readonly ClinicRoute[]) {
  assertRoutes(routes);
  for (const route of routes) router[route.method](route.path, route.handler);
}
