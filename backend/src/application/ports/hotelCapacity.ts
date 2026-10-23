export type RoomCapacityValue = { roomType: string; capacity: number; updatedAt: Date };

export interface HotelCapacityRepository {
  list(): Promise<RoomCapacityValue[]>;
  // Sets the type's capacity and that of every night from `from` on, in one
  // transaction; 409 when one of those nights already holds more stays.
  set(roomType: string, capacity: number, from: Date): Promise<RoomCapacityValue>;
}
