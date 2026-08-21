import { appointments, pets } from "../../data/mockData";
import { useAppStore } from "../../store/AppStoreProvider";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels } from "../../utils/statusLabels";
import { StatusBadge } from "../ui/StatusBadge";

export function DataTable({ type }: { type: "appointments" | "pets" | "bookings" }) {
  const { hotelBookings, owners, pets: storePets } = useAppStore();
  const headers = type === "appointments" ? ["Time", "Pet", "Service", "Doctor", "Status"] : type === "pets" ? ["Pet", "Breed", "Age", "Owner", "Status"] : ["Pet", "Owner", "Dates", "Room", "Total", "Status"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">{headers.map((header) => <th key={header} className="p-3">{header}</th>)}</tr>
        </thead>
        <tbody>
          {type === "appointments" && appointments.map((item) => (
            <tr key={item.time} className="border-b"><td className="p-3 font-bold">{item.time}</td><td>{item.pet}</td><td>{item.service}</td><td>{item.doctor}</td><td><StatusBadge>{item.status}</StatusBadge></td></tr>
          ))}
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