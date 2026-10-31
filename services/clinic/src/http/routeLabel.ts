// The metric label of a route Clinic serves, such as '/api/appointments/:id/status'. Anything else is undefined and the
// runtime labels it 'unknown', so an id never becomes a label of its own. The label is read from the path, not from
// req.route: a request refused before the router has no route.
// Clinic has no sign-in or public routes, so its runtime passes no limit rules and the general per-client limit is the
// whole policy.
export function clinicRouteLabel(p: string): string | undefined {
  const fixed =
    /^\/api\/(dashboard\/clinic(\/activity)?|appointments\/(calendar|availability)|medical-records\/images|appointments|medical-records)$/;
  if (fixed.test(p)) return p;
  const item = p.match(
    /^\/api\/(appointments|medical-records)\/[^/]{1,200}(\/(status|reschedule|cancel|status-history|history|undo-status|reminder))?$/,
  );
  if (item) return `/api/${item[1]}/:id${item[2] ?? ''}`;
  const image = p.match(/^\/api\/medical-records\/images\/[^/]{1,200}(\/restore)?$/);
  if (image) return `/api/medical-records/images/:id${image[1] ?? ''}`;
  return undefined;
}
