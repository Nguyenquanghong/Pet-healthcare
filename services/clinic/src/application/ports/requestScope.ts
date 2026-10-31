// Which pet a resource named in a URL belongs to, so Core can be asked about that pet before a handler runs.
// Each lookup resolves to the pet's id, or to null when the resource does not exist.
export interface ScopeLookup {
  petOfAppointment(id: string): Promise<string | null>;
  petOfMedicalRecord(id: string): Promise<string | null>;
  petOfMedicalImage(id: string): Promise<string | null>;
  // AQ-15: the history of a deleted record outlives it; it is scoped by the pet in the record's last revision snapshot.
  petOfDeletedRecord(id: string): Promise<string | null>;
}
