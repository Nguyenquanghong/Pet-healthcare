export type Owner = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  passwordHash?: string;
  passwordSalt?: string;
  address?: string;
  petIds: string[];
};
