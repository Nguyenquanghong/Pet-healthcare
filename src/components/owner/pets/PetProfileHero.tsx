import { Box, Mars, Venus } from "lucide-react";
import type { Pet } from "../../../types/pet";

const genderLabels = {
  male: "Đực",
  female: "Cái",
  unknown: "Chưa rõ",
};

const healthStatusLabels = {
  healthy: "Khỏe mạnh",
  stable: "Ổn định",
  vaccination_due: "Cần tiêm phòng",
  under_treatment: "Đang điều trị",
  critical: "Cần theo dõi sát",
};

export function PetProfileHero({ pet }: { pet: Pet }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm flex flex-col md:flex-row">
      <div className="md:w-1/2 relative bg-slate-100 min-h-64 flex items-center justify-center p-6">
        <div className="text-6xl text-slate-300">
          {pet.species === "cat" ? "🐈" : pet.species === "rabbit" ? "🐇" : pet.species === "dog" ? "🐕" : "🐾"}
        </div>
        <button className="absolute bottom-4 right-4 bg-white/80 backdrop-blur px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-700 flex items-center gap-2 border border-slate-200 shadow-sm hover:bg-white transition-colors">
          <Box size={16} />
          360° View
        </button>
      </div>
      
      <div className="p-6 md:p-8 flex flex-col justify-between flex-1">
        <div>
          <h2 className="text-3xl font-black text-primary">{pet.name}</h2>
          
          <div className="mt-6 grid grid-cols-2 gap-y-6 gap-x-4">
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Breed</p>
              <p className="mt-1 font-semibold text-slate-900">{pet.breed}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Age</p>
              <p className="mt-1 font-semibold text-slate-900">{pet.ageLabel}</p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Gender</p>
              <p className="mt-1 font-semibold text-slate-900 flex items-center gap-1">
                {pet.gender === "female" ? <Venus size={16} className="text-rose-500" /> : <Mars size={16} className="text-blue-500" />}
                {genderLabels[pet.gender]}
              </p>
            </div>
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Status</p>
              <p className="mt-1 font-semibold text-slate-900">{healthStatusLabels[pet.healthStatus]}</p>
            </div>
          </div>
        </div>
        
        <div className="mt-8 rounded-xl bg-slate-50 p-4 border border-slate-100 inline-block">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Microchip ID (ISO)</p>
          <p className="mt-1 text-lg font-bold text-primary tracking-widest">
            {pet.microchipId ?? "Chưa cập nhật"}
          </p>
        </div>
      </div>
    </div>
  );
}
