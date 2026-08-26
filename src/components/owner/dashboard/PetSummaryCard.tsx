import type { Pet } from "../../../types/pet";

export function PetSummaryCard({ pet }: { pet: Pet }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-slate-100">
          <img 
            src={pet.avatarUrl || `https://api.dicebear.com/7.x/shapes/svg?seed=${pet.name}&backgroundColor=f1f5f9`}
            alt={pet.name} 
            className="h-full w-full object-cover" 
          />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-slate-900">{pet.name}</h3>
          <p className="mt-0.5 truncate text-sm text-slate-500">
            {pet.breed} &bull; {pet.ageLabel}
          </p>
          {pet.allergies?.length ? (
            <p className="mt-1 truncate text-xs text-slate-500">Dị ứng: {pet.allergies.join(", ")}</p>
          ) : null}
        </div>
    </div>
  );
}
