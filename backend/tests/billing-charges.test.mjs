import assert from "node:assert/strict";
import test from "node:test";
import { charges, fees, lines, money } from "../dist/src/domain/billing/charges.js";
import { billingOperationTransitions, isPending, terminalState } from "../dist/src/domain/billing/operation.js";

// Appointment billing arithmetic and the state rule of a billing operation, without a database or a service.
// The keys of fees() are the request hash of an operation: the saga stores JSON.stringify(fees(...)) and compares
// it on every retry, so a reordered key answers a retry that is still running with 409 "different charges".

const refuses = (work, status, message) => assert.throws(work, error => error.status === status && (!message || error.message === message));
const snapshot = (extra = {}) => ({ appointmentId: "appt-1", revision: 3, ownerId: "owner-1", petId: "pet-1", type: "general_checkup", serviceName: "Khám tổng quát", clinicName: "Clinic", date: "2030-01-02", time: "09:00", ...extra });

test("money is a whole, non-negative VND amount up to 9,999,999,999", () => {
  for (const value of [0, 1, 250000, 9_999_999_999]) assert.equal(money(value, "Tax"), value);
  for (const value of [-1, 0.5, 10_000_000_000, "1", null, undefined, NaN, Infinity]) refuses(() => money(value, "Tax"), 422);
  refuses(() => money(-1, "Giảm giá"), 422, "Giảm giá phải là số tiền VND nguyên, không âm và không quá 9.999.999.999.");
});

test("lines trims the description and prices each line as unit price times quantity", () => {
  assert.deepEqual(lines([{ description: " Vaccine ", quantity: 2, unitPrice: 50000 }]), [{ description: "Vaccine", unitPrice: 50000, quantity: 2, amount: 100000 }]);
  assert.deepEqual(Object.keys(lines([{ description: "x", quantity: 1, unitPrice: 1 }])[0]), ["description", "unitPrice", "quantity", "amount"]);
  assert.deepEqual(lines([]), []);
  refuses(() => lines("x"), 422, "Tối đa 50 dòng dịch vụ.");
  refuses(() => lines(Array.from({ length: 51 }, () => ({ description: "x", quantity: 1, unitPrice: 1 }))), 422, "Tối đa 50 dòng dịch vụ.");
  assert.equal(lines(Array.from({ length: 50 }, () => ({ description: "x", quantity: 1, unitPrice: 1 }))).length, 50);
  for (const description of [undefined, 5, " ", "d".repeat(301)]) refuses(() => lines([{ description, quantity: 1, unitPrice: 1 }]), 422, "Mỗi dòng cần mô tả dịch vụ (tối đa 300 ký tự).");
  for (const quantity of [0, 1.5, 10001, "1"]) refuses(() => lines([{ description: "x", quantity, unitPrice: 1 }]), 422, "Số lượng phải từ 1 đến 10.000.");
  refuses(() => lines([{ description: "x", quantity: 1, unitPrice: -1 }]), 422);
  refuses(() => lines([{ description: "x", quantity: 10000, unitPrice: 1_000_000 }]), 422);
  refuses(() => lines([null]), 422);
});

test("fees validates the source and keeps its keys in one order", () => {
  assert.equal(JSON.stringify(fees({ type: "appointment", relatedId: "appt-1", subtotal: 150000 }, false)), '{"relatedId":"appt-1","subtotal":150000,"taxAmount":0,"discountAmount":0,"notes":null}');
  assert.equal(JSON.stringify(fees({ type: "appointment", relatedId: "appt-2", items: [{ description: " Vaccine ", quantity: 2, unitPrice: 50000 }, { description: "Exam", quantity: 1, unitPrice: 20000 }] }, false)),
    '{"relatedId":"appt-2","items":[{"description":"Vaccine","unitPrice":50000,"quantity":2,"amount":100000},{"description":"Exam","unitPrice":20000,"quantity":1,"amount":20000}],"taxAmount":0,"discountAmount":0,"notes":null}');
  assert.equal(JSON.stringify(fees({ type: "appointment", relatedId: " appt-3 ", subtotal: 10, taxAmount: 5, discountAmount: 2, notes: " note ", expectedRevision: 4 }, false)),
    '{"relatedId":"appt-3","subtotal":10,"taxAmount":5,"discountAmount":2,"notes":"note","expectedRevision":4}');
  assert.equal(JSON.stringify(fees({ type: "appointment", relatedId: "appt-4" }, true)), '{"relatedId":"appt-4","taxAmount":0,"discountAmount":0,"notes":null}');
  assert.equal(fees({ type: "appointment", relatedId: "a", subtotal: 1, notes: "   " }, false).notes, null);
  assert.equal(fees({ type: "appointment", relatedId: "a", subtotal: 1, expectedRevision: 0 }, false).expectedRevision, 0);
  // items win over a subtotal that comes with them
  assert.equal("subtotal" in fees({ type: "appointment", relatedId: "a", subtotal: 9, items: [{ description: "x", quantity: 1, unitPrice: 1 }] }, false), false);
});

test("fees refuses what the server must not accept", () => {
  const base = { type: "appointment", relatedId: "a", subtotal: 1 };
  for (const input of [null, [], {}, { ...base, type: "hotel_booking" }, { ...base, relatedId: 5 }, { ...base, relatedId: " " }, { ...base, relatedId: "r".repeat(129) }])
    refuses(() => fees(input, false), 422, "Invalid appointment billing source.");
  assert.equal(fees({ ...base, relatedId: "r".repeat(128) }, false).relatedId.length, 128);
  refuses(() => fees(base, true), 422, "Prices are calculated by the server.");
  assert.doesNotThrow(() => fees({ type: "appointment", relatedId: "a" }, true));
  for (const notes of [5, "n".repeat(2001)]) refuses(() => fees({ ...base, notes }, false), 422, "Invalid invoice notes.");
  for (const expectedRevision of [-1, 1.5, "1", 2147483648, null]) refuses(() => fees({ ...base, expectedRevision }, false), 422, "Invalid source revision.");
  assert.equal(fees({ ...base, expectedRevision: 2147483647 }, false).expectedRevision, 2147483647);
  refuses(() => fees({ type: "appointment", relatedId: "a" }, false), 422);
  refuses(() => fees({ ...base, taxAmount: "1" }, false), 422);
  refuses(() => fees({ ...base, discountAmount: -1 }, false), 422);
});

test("charges prices a staff invoice from the subtotal or the lines, and a checkout at the fixed rate", () => {
  const staff = (extra, snap = snapshot()) => charges({ relatedId: "appt-1", taxAmount: 0, discountAmount: 0, notes: null, ...extra }, snap, false);
  assert.deepEqual(staff({ subtotal: 150000, taxAmount: 15000, discountAmount: 5000, notes: "n" }), { items: [{ description: "Khám tổng quát", quantity: 1, unitPrice: 150000, amount: 150000 }], subtotal: 150000, taxAmount: 15000, discountAmount: 5000, totalAmount: 160000, notes: "n" });
  assert.deepEqual(Object.keys(staff({ subtotal: 1 })), ["items", "subtotal", "taxAmount", "discountAmount", "totalAmount", "notes"]);
  const items = [{ description: "A", quantity: 2, unitPrice: 100, amount: 200 }, { description: "B", quantity: 1, unitPrice: 50, amount: 50 }];
  assert.deepEqual(staff({ items, taxAmount: 20, discountAmount: 10 }), { items, subtotal: 250, taxAmount: 20, discountAmount: 10, totalAmount: 260, notes: null });
  const spa = charges({ relatedId: "appt-1", taxAmount: 0, discountAmount: 0, notes: null }, snapshot({ type: "spa_bath", serviceName: "Tắm" }), true);
  assert.deepEqual(spa.items, [{ description: "Tắm", quantity: 1, unitPrice: 250000, amount: 250000 }]);
  assert.equal(spa.totalAmount, 250000);
  // a self-service checkout ignores any price in the payload
  assert.equal(charges({ relatedId: "a", subtotal: 1, taxAmount: 0, discountAmount: 0, notes: null }, snapshot({ type: "spa_combo" }), true).totalAmount, 650000);
});

test("charges refuses a checkout without a fixed rate, no lines, an oversized discount and a total that is not positive", () => {
  const input = { relatedId: "appt-1", taxAmount: 0, discountAmount: 0, notes: null };
  refuses(() => charges(input, snapshot(), true), 409, "This service requires staff to settle charges.");
  refuses(() => charges({ ...input, items: [] }, snapshot(), false), 422, "Invoice requires at least one service.");
  refuses(() => charges({ ...input, subtotal: 100, discountAmount: 101 }, snapshot(), false), 422, "Discount exceeds subtotal.");
  assert.equal(charges({ ...input, subtotal: 100, discountAmount: 100, taxAmount: 1 }, snapshot(), false).totalAmount, 1);
  refuses(() => charges({ ...input, subtotal: 100, discountAmount: 100 }, snapshot(), false), 422, "Invoice total must be positive.");
  refuses(() => charges({ ...input, subtotal: 0 }, snapshot(), false), 422, "Invoice total must be positive.");
});

test("an operation leaves PREPARING once; pending is the string PREPARING and nothing else", () => {
  assert.deepEqual(billingOperationTransitions, { PREPARING: ["COMMITTED", "ABORTED"], COMMITTED: [], ABORTED: [] });
  assert.equal(isPending("PREPARING"), true);
  // state is a free String in the database: any other value, in any case, is not pending
  for (const state of ["COMMITTED", "ABORTED", "preparing", "PREPARING ", "", "constructor", "toString", "__proto__", "FINALIZED"]) assert.equal(isPending(state), false, state);
  assert.equal(terminalState("commit"), "COMMITTED");
  assert.equal(terminalState("abort"), "ABORTED");
  for (const target of billingOperationTransitions.PREPARING) assert.equal(isPending(target), false);
});
