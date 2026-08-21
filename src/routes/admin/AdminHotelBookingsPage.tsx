import { AppLayout } from "../../components/layout/AppLayout";
import { Card } from "../../components/ui/Card";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useAppStore } from "../../store/AppStoreProvider";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels } from "../../utils/statusLabels";

export function AdminHotelBookingsPage() {
  const { hotelBookings, owners, pets, updateHotelBookingStatus } = useAppStore();

  return (
    <AppLayout type="admin" title="Quản lý Hotel Booking">
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-3">Pet</th>
                <th>Owner</th>
                <th>Dates</th>
                <th>Room</th>
                <th>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {hotelBookings.map((booking) => {
                const pet = pets.find((item) => item.id === booking.petId);
                const owner = owners.find((item) => item.id === booking.ownerId);
                return (
                  <tr key={booking.id} className="border-b align-top">
                    <td className="p-3 font-bold">{pet?.name ?? booking.petId}</td>
                    <td>{owner?.fullName ?? booking.ownerId}</td>
                    <td>{booking.checkIn} → {booking.checkOut}</td>
                    <td className="capitalize">{booking.roomType}</td>
                    <td>{formatCurrency(booking.totalAmount)}</td>
                    <td><StatusBadge status={booking.status}>{bookingStatusLabels[booking.status]}</StatusBadge></td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <button disabled={booking.status !== "pending"} onClick={() => updateHotelBookingStatus(booking.id, "confirmed")} className="rounded-lg bg-primary px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">Confirm</button>
                        <button disabled={booking.status !== "pending"} onClick={() => updateHotelBookingStatus(booking.id, "rejected")} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">Reject</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </AppLayout>
  );
}