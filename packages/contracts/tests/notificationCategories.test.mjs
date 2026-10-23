import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingStatusUpdated, hotelStatusUpdates, isNotificationCategory, notificationCategories, notificationCategory, notificationCategoryCounts,
  notificationCategoryNames, notificationCategoryWhere, notificationTypes } from '../dist/index.js';

// Evaluates the Prisma filter subset notificationCategoryWhere emits against a row.
const matches = (where, row) => where.OR ? where.OR.some(part => matches(part, row)) : Object.entries(where).every(([key, condition]) =>
  condition === null ? row[key] == null : typeof condition !== 'object' ? row[key] === condition : condition.in ? condition.in.includes(row[key])
    : condition.not === null ? row[key] != null : assert.fail('unsupported filter ' + JSON.stringify(condition)));
const rows = [...notificationTypes.flatMap(type => [{ type, relatedBookingId: null }, { type, relatedBookingId: 'b1', relatedAppointmentId: null }]),
  { type: bookingStatusUpdated, relatedAppointmentId: 'a1' }, { type: 'unknown_type', relatedBookingId: 'b1' }];

test('every listed type has exactly one tab; status updates are the only type shared by two', () => {
  const listed = Object.values(notificationCategories).flat();
  assert.equal(new Set(listed).size, listed.length, 'a type is listed in two tabs');
  assert.deepEqual([...notificationTypes].sort(), [...listed, bookingStatusUpdated].sort());
  assert.ok(!listed.includes(bookingStatusUpdated));
  assert.ok(notificationCategoryNames.every(isNotificationCategory));
  for (const value of ['all', 'toString', 'hasOwnProperty', 'unknown', '', null]) assert.equal(isNotificationCategory(value), false, String(value));
});

test('a status update belongs to the booking it names: hotel with relatedBookingId, otherwise appointments', () => {
  assert.equal(notificationCategory({ type: bookingStatusUpdated, relatedBookingId: 'b1' }), 'hotel');
  assert.equal(notificationCategory({ type: bookingStatusUpdated, relatedAppointmentId: 'a1' }), 'appointments');
  assert.equal(notificationCategory({ type: bookingStatusUpdated }), 'appointments');
  assert.equal(notificationCategory({ type: 'invoice_paid' }), 'billing');
  assert.equal(notificationCategory({ type: 'pet_rescue_report' }), 'rescue');
  assert.equal(notificationCategory({ type: 'unknown_type' }), undefined);
});

test('each tab filter selects exactly the rows the classifier puts in that tab', () => {
  for (const category of notificationCategoryNames)
    for (const row of rows) assert.equal(matches(notificationCategoryWhere(category), row), notificationCategory(row) === category, `${category} ${JSON.stringify(row)}`);
  assert.equal(matches(hotelStatusUpdates, { type: bookingStatusUpdated, relatedBookingId: 'b1' }), true);
  assert.equal(matches(hotelStatusUpdates, { type: bookingStatusUpdated, relatedBookingId: null }), false);
});

test('counts from a group-by on type split status updates by booking and omit empty tabs', () => {
  const counts = notificationCategoryCounts([{ type: bookingStatusUpdated, count: 5 }, { type: 'appointment_created', count: 1 }, { type: 'invoice_paid', count: 2 },
    { type: 'unknown_type', count: 4 }], 3);
  assert.deepEqual(counts, { hotel: 3, appointments: 3, billing: 2 });
  assert.deepEqual(notificationCategoryCounts([{ type: bookingStatusUpdated, count: 2 }], 2), { hotel: 2 });
  assert.deepEqual(notificationCategoryCounts([], 0), {});
  // The same total the tab filters would count one by one.
  const sample = rows.filter(row => notificationCategory(row));
  const byType = Object.entries(Object.groupBy(sample, row => row.type)).map(([type, list]) => ({ type, count: list.length }));
  const expected = Object.fromEntries(notificationCategoryNames.map(c => [c, sample.filter(row => matches(notificationCategoryWhere(c), row)).length]).filter(([, n]) => n));
  assert.deepEqual(notificationCategoryCounts(byType, sample.filter(row => matches(hotelStatusUpdates, row)).length), expected);
});
