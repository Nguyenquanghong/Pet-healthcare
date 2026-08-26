import { Mars, Venus } from "lucide-react";
import type { Pet } from "../../../types/pet";

const genderLabels = {
  male: "Đực",
  female: "Cái",
  unknown: "Chưa rõ",
};

export function PetProfileHero({ pet }: { pet: Pet }) {
  return (
    <div className="flex flex-col overflow-hidden bg-white md:flex-row">
      <div className="relative flex min-h-[220px] items-center justify-center bg-slate-100 p-6 md:w-[46%]">
        {pet.avatarUrl ? (
          <img src={pet.avatarUrl} alt={pet.name} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="text-6xl text-slate-300">
            {pet.species === "cat" ? "🐈" : pet.species === "rabbit" ? "🐇" : pet.species === "dog" ? "🐕" : "🐾"}
          </div>
        )}
      </div>
      
      <div className="flex flex-1 flex-col justify-center p-6 md:p-8">
        <div>
          <h2 className="text-2xl font-semibold text-primary">{pet.name}</h2>
          
          <div className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2">
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
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Allergies</p>
              <p className="mt-1 font-semibold text-slate-900">{pet.allergies?.join(", ") || "Không ghi nhận"}</p>
            </div>
          </div>
        </div>
        
      </div>
    </div>
  );
}
