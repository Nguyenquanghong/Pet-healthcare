import { Router, Request, Response } from "express";
import { db } from "../db";

export const appointmentsRouter = Router();

// GET /api/appointments
appointmentsRouter.get("/", (req: Request, res: Response) => {
  const { ownerId, petId, status, date } = req.query;
  let list = db.get().appointments;

  if (ownerId) list = list.filter((a) => a.ownerId === String(ownerId));
  if (petId) list = list.filter((a) => a.petId === String(petId));
  if (status && status !== "all") list = list.filter((a) => a.status === String(status));
  if (date) list = list.filter((a) => a.date === String(date));

  return res.json(list);
});

// POST /api/appointments
appointmentsRouter.post("/", (req: Request, res: Response) => {
  const { petId, ownerId, doctorId, type, serviceName, date, time, ownerNote } = req.body;
  if (!petId || !date || !time) {
    return res.status(422).json({ error: "Thông tin thú cưng, ngày và giờ khám là bắt buộc" });
  }

  const now = new Date().toISOString();
  const newAppointment = {
    id: `appointment_${Date.now()}`,
    petId,
    ownerId: ownerId || "owner_1",
    doctorId: doctorId || "doctor_mai",
    type: type || "general_checkup",
    serviceName: serviceName || "Khám tổng quát",
    clinicName: "Bệnh viện Thú y Mỹ Đình",
    date,
    time,
    status: "pending",
    ownerNote: ownerNote?.trim(),
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  };

  const pet = db.get().pets.find((p) => p.id === petId);
  const owner = db.get().users.find((u) => u.id === newAppointment.ownerId);

  // Auto-generate notifications
  const ownerNoti = {
    id: `noti_${Date.now()}_owner`,
    recipientOwnerId: newAppointment.ownerId,
    recipientRole: "owner" as const,
    type: "appointment_created",
    title: "Đã gửi yêu cầu đặt lịch",
    message: `Lịch ${newAppointment.serviceName} lúc ${newAppointment.time} ngày ${newAppointment.date} đang chờ xác nhận.`,
    status: "sent" as const,
    actionUrl: "/owner/appointments",
    relatedAppointmentId: newAppointment.id,
    relatedPetId: newAppointment.petId,
    createdAt: now,
    sentAt: now,
  };

  const adminNoti = {
    id: `noti_${Date.now()}_admin`,
    recipientRole: "admin" as const,
    type: "appointment_created",
    title: "Lịch khám mới",
    message: `Bệnh nhân ${pet?.name || "Pet"} (Chủ: ${owner?.fullName || "Khách hàng"}) vừa đặt lịch ${newAppointment.serviceName} lúc ${newAppointment.time} ngày ${newAppointment.date}.`,
    status: "sent" as const,
    actionUrl: "/admin/appointments",
    relatedAppointmentId: newAppointment.id,
    relatedPetId: newAppointment.petId,
    createdAt: now,
    sentAt: now,
  };

  db.update((draft) => {
    draft.appointments.unshift(newAppointment);
    draft.notifications.unshift(adminNoti, ownerNoti);
  });

  return res.status(201).json({ message: "Đặt lịch khám thành công", appointment: newAppointment });
});

// PATCH /api/appointments/:id/status
appointmentsRouter.patch("/:id/status", (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, internalNote } = req.body;

  const apptIndex = db.get().appointments.findIndex((a) => a.id === id);
  if (apptIndex === -1) return res.status(404).json({ error: "Không tìm thấy lịch khám" });

  let updatedAppt: any;
  const now = new Date().toISOString();

  db.update((draft) => {
    draft.appointments[apptIndex] = {
      ...draft.appointments[apptIndex],
      status: status || draft.appointments[apptIndex].status,
      internalNote: internalNote !== undefined ? internalNote : draft.appointments[apptIndex].internalNote,
      updatedAt: now,
    };
    updatedAppt = draft.appointments[apptIndex];

    // Notification to owner on confirmation or cancellation
    if (status === "confirmed") {
      draft.notifications.unshift({
        id: `noti_${Date.now()}`,
        recipientOwnerId: updatedAppt.ownerId,
        recipientRole: "owner",
        type: "appointment_confirmed",
        title: "Lịch khám đã được xác nhận",
        message: `Lịch ${updatedAppt.serviceName} lúc ${updatedAppt.time} ngày ${updatedAppt.date} đã được bác sĩ xác nhận.`,
        status: "sent",
        actionUrl: "/owner/appointments",
        relatedAppointmentId: updatedAppt.id,
        relatedPetId: updatedAppt.petId,
        createdAt: now,
        sentAt: now,
      });
    }
  });

  return res.json({ message: "Cập nhật trạng thái lịch khám thành công", appointment: updatedAppt });
});

// PATCH /api/appointments/:id/reschedule
appointmentsRouter.patch("/:id/reschedule", (req: Request, res: Response) => {
  const { id } = req.params;
  const { date, time, ownerNote } = req.body;

  const apptIndex = db.get().appointments.findIndex((a) => a.id === id);
  if (apptIndex === -1) return res.status(404).json({ error: "Không tìm thấy lịch khám" });

  let updatedAppt: any;
  const now = new Date().toISOString();

  db.update((draft) => {
    draft.appointments[apptIndex] = {
      ...draft.appointments[apptIndex],
      date,
      time,
      status: "pending",
      ownerNote: ownerNote ? ownerNote : draft.appointments[apptIndex].ownerNote,
      updatedAt: now,
    };
    updatedAppt = draft.appointments[apptIndex];
  });

  return res.json({ message: "Yêu cầu dời lịch khám đã được gửi", appointment: updatedAppt });
});

// PATCH /api/appointments/:id/cancel
appointmentsRouter.patch("/:id/cancel", (req: Request, res: Response) => {
  const { id } = req.params;
  const { ownerNote } = req.body;

  const apptIndex = db.get().appointments.findIndex((a) => a.id === id);
  if (apptIndex === -1) return res.status(404).json({ error: "Không tìm thấy lịch khám" });

  let updatedAppt: any;
  const now = new Date().toISOString();

  db.update((draft) => {
    draft.appointments[apptIndex] = {
      ...draft.appointments[apptIndex],
      status: "cancelled",
      ownerNote: ownerNote ? `Lý do hủy: ${ownerNote}` : draft.appointments[apptIndex].ownerNote,
      updatedAt: now,
    };
    updatedAppt = draft.appointments[apptIndex];
  });

  return res.json({ message: "Đã hủy lịch khám thành công", appointment: updatedAppt });
});
