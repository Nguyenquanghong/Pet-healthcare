import type { Actor } from '../../domain/auth.js';

export type PetSnapshot={id:string;ownerId:string;name:string;directoryVersion:number;[key:string]:unknown};
export type OwnerSnapshot={id:string;fullName:string;directoryVersion:number;[key:string]:unknown};
export type DirectorySnapshot={actor:Actor&{fullName:string};pets:PetSnapshot[];owners:OwnerSnapshot[]};

// Per-request directory view authorized by Core for the verified actor.
// Adapter: RequestDirectory (directory.ts); the port lives here so application
// code never depends on the HTTP adapter.
export interface DirectoryLookup {
  pet(id:string):Promise<PetSnapshot>;
  lookup(petIds:string[],ownerIds:string[]):Promise<DirectorySnapshot>;
}
