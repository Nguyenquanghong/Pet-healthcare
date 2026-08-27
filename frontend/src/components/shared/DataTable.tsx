import { pets } from "../../data/mockData";
import { useAppStore } from "../../store/AppStoreProvider";
import { formatCurrency } from "../../utils/formatCurrency";
import { appointmentStatusLabels, bookingStatusLabels } from "../../utils/statusLabels";
import { StatusBadge } from "../ui/StatusBadge";

export function DataTable({ type }: { type: "appointments" | "pets" | "bookings" }) {
  const { appointments, hotelBookings, owners, pets: storePets } = useAppStore();
  const headers = type === "appointments" ? ["Time", "Pet", "Service", "Doctor", "Status"] : type === "pets" ? ["Pet", "Breed", "Age", "Owner", "Status"] : ["Pet", "Owner", "Dates", "Room", "Total", "Status"];
  return (
    <div className="overscroll-x-contain overflow-x-auto">
      <table className="min-w-[680px] w-full text-left text-sm">
        <thead>
          <tr className="border-b">{headers.map((header) => <th key={header} className="p-3">{header}</th>)}</tr>
        </thead>
        <tbody>
          {type === "appointments" && appointments.map((item) => {
            const pet = storePets.find((petItem) => petItem.id === item.petId);
            return <tr key={item.id} className="border-b"><td className="p-3 font-bold">{item.time}</td><td>{pet?.name ?? item.petId}</td><td>{item.serviceName}</td><td>{item.doctorId ?? "Bs. Mai Nguyễn"}</td><td><StatusBadge status={item.status}>{appointmentStatusLabels[item.status]}</StatusBadge></td></tr>;
          })}
          {type === "pets" && pets.map((item) => (
            <tr key={item.id} className="border-b"><td className="p-3 font-bold">{item.name}</td><td>{item.breed}</td><td>{item.age}</td><td>{item.owner}</td><td><StatusBadge>{item.status}</StatusBadge></td></tr>
          ))}
          {type === "bookings" && hotelBookings.map((item) => {
            const pet = storePets.find((petItem) => petItem.id === item.petId);
            const owner = owners.find((ownerItem) => ownerItem.id === item.ownerId);
            return <tr key={item.id} className="border-b"><td className="p-3 font-bold">{pet?.name ?? item.petId}</td><td>{owner?.fullName ?? item.ownerId}</td><td>{item.checkIn} → {item.checkOut}</td><td className="capitalize">{item.roomType}</td><td>{formatCurrency(item.totalAmount)}</td><td><StatusBadge status={item.status}>{bookingStatusLabels[item.status]}</StatusBadge></td></tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}
