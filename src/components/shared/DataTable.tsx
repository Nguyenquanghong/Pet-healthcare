import { appointments, bookings, pets } from "../../data/mockData";
import { formatCurrency } from "../../utils/formatCurrency";
import { StatusBadge } from "../ui/StatusBadge";

export function DataTable({ type }: { type: "appointments" | "pets" | "bookings" }) {
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
          {type === "bookings" && bookings.map((item) => (
            <tr key={`${item.pet}-${item.dates}`} className="border-b"><td className="p-3 font-bold">{item.pet}</td><td>{item.owner}</td><td>{item.dates}</td><td>{item.room}</td><td>{formatCurrency(item.total)}</td><td><StatusBadge>{item.status}</StatusBadge></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}