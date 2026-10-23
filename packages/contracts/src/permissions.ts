// AQ-05: the one permission matrix for Core, Clinic and Notification (policy as
// code). A service asks `allows(role, permission)` before a role-restricted
// operation; ownership scope (an owner only reaches their own rows) stays in each
// service. Changing who may do what is a change to this table only:
// tools/phase2/check-architecture-rules.mjs rejects role checks written anywhere
// else, and the permission-matrix tests are generated from it.
export const roles = ['owner', 'doctor', 'staff', 'admin'] as const;
export type Role = typeof roles[number];

export const permissionMatrix = {
  'booking.manage': { roles: ['doctor', 'staff', 'admin'], denied: 'Chỉ nhân viên được thực hiện thao tác này.' },
  'booking.reopen': { roles: ['admin'], denied: 'Chỉ quản trị viên được mở lại dịch vụ đã hoàn thành.' },
  'hotel.care-note.write': { roles: ['doctor', 'staff', 'admin'], denied: 'Chỉ nhân viên được ghi nhật ký chăm sóc.' },
  'hotel.capacity.manage': { roles: ['admin'], denied: 'Chỉ quản trị viên được đổi sức chứa phòng.' },
  'medical-record.write': { roles: ['doctor', 'admin'], denied: 'Chỉ bác sĩ hoặc quản trị viên được ghi bệnh án và ảnh y tế.' },
  // P11: everyone else who writes a record signs it as themself.
  'medical-record.assign-doctor': { roles: ['admin'], denied: 'Chỉ quản trị viên được lập bệnh án đứng tên bác sĩ khác.' },
  'medical-record.history': { roles: ['doctor', 'staff', 'admin'], denied: 'Chỉ nhân viên được xem lịch sử bệnh án.' },
  'medical-record.restore': { roles: ['admin'], denied: 'Chỉ quản trị viên được khôi phục ảnh y tế đã xóa.' },
  'billing.manage': { roles: ['staff', 'admin'], denied: 'Chỉ nhân viên thu ngân hoặc quản trị viên được lập hóa đơn và xác nhận thu tiền.' },
  'billing.audit': { roles: ['doctor', 'staff', 'admin'], denied: 'Chỉ nhân viên được xem thống kê và lịch sử thu tiền.' },
  'billing.self-service': { roles: ['owner'], denied: 'Chỉ chủ nuôi được tự thanh toán hóa đơn của mình.' },
  'owner.manage': { roles: ['staff', 'admin'], denied: 'Chỉ quản trị viên hoặc nhân viên được tạo khách và cấp liên kết kích hoạt.' },
  'directory.read': { roles: ['doctor', 'staff', 'admin'], denied: 'Danh bạ chủ nuôi chỉ dành cho nhân viên.' },
  'notification.send': { roles: ['staff', 'admin'], denied: 'Chỉ nhân viên hoặc quản trị viên được gửi thông báo.' },
  'clinic-activity.read': { roles: ['admin'], denied: 'Admin activity access is required.' },
} as const satisfies Record<string, { roles: readonly Role[]; denied: string }>;
export type Permission = keyof typeof permissionMatrix;
export const permissions = Object.keys(permissionMatrix) as Permission[];

export function allows(role: unknown, permission: Permission): boolean {
  return (permissionMatrix[permission].roles as readonly unknown[]).includes(role);
}
export function deniedMessage(permission: Permission): string {
  return permissionMatrix[permission].denied;
}
// What a session may do, for clients that hide actions they cannot perform. The
// server still checks every request; this list is only a UI hint.
export function permissionsFor(role: unknown): Permission[] {
  return permissions.filter(permission => allows(role, permission));
}
