export type ServiceName = 'core' | 'clinic' | 'notification';
export type GatewayRoute = { readonly prefix: `/api/${string}`; readonly service: Exclude<ServiceName, 'core'> };

// Paths the gateway sends to a split service; every other /api path is Core's.
// Match is case-sensitive and on a segment boundary.
export const gatewayRoutes = [
  { prefix: '/api/appointments', service: 'clinic' },
  { prefix: '/api/medical-records', service: 'clinic' },
  { prefix: '/api/dashboard/clinic', service: 'clinic' },
  { prefix: '/api/notifications', service: 'notification' },
] as const satisfies readonly GatewayRoute[];

export const gatewayTopologies = {
  // compose, demo, dev, E2E, P7: every /api/ goes to Core and Core's serviceProxy forwards.
  'core-ingress': { ownedRoutesVia: 'core' },
  // nginx.split example, measurement: each owned prefix goes straight to its service.
  direct: { ownedRoutesVia: 'owner' },
} as const;

export const servicePrefixes = (service: GatewayRoute['service']): readonly string[] =>
  gatewayRoutes.filter(route => route.service === service).map(route => route.prefix);

// Same match as backend/src/gateway/serviceProxy.ts: the whole path, or the prefix and a '/'.
export function routeOwner(pathname: string): ServiceName {
  const route = gatewayRoutes.find(r => pathname === r.prefix || pathname.startsWith(r.prefix + '/'));
  return route ? route.service : 'core';
}
