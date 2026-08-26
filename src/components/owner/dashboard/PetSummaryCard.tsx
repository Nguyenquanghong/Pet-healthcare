import { Cpu } from "lucide-react";
import type { Pet } from "../../../types/pet";

export function PetSummaryCard({ pet }: { pet: Pet }) {
  const isHealthy = pet.healthStatus === "healthy";
  
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="p-5 flex items-start gap-4">
        <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-2xl bg-slate-100">
          <img 
            src={pet.avatarUrl || `https://api.dicebear.com/7.x/shapes/svg?seed=${pet.name}&backgroundColor=f1f5f9`}
            alt={pet.name} 
            className="h-full w-full object-cover" 
          />
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-lg font-bold text-slate-900">{pet.name}</h3>
              <p className="text-sm text-slate-500">
                {pet.breed} &bull; {pet.ageLabel}
              </p>
            </div>
            <div className={`px-3 py-1 rounded-xl text-sm font-semibold ${isHealthy ? 'bg-aqua/20 text-teal-700' : 'bg-orange-100 text-orange-700'}`}>
              {isHealthy ? "Khỏe mạnh" : "Tiêm phòng"}
            </div>
          </div>
        </div>
      </div>
      
      <div className="border-t border-slate-100 bg-slate-50 p-3 mx-4 mb-4 rounded-xl flex items-center gap-3">
        <Cpu size={16} className="text-slate-400" />
        <div>
          <p className="text-xs text-slate-500">Microchip ID (ISO)</p>
          <p className="font-semibold text-primary">90021500000{pet.id.length > 5 ? pet.id.substring(0, 4) : "0001"}</p>
        </div>
      </div>
    </div>
  );
}
