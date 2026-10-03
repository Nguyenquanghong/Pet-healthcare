export type Owner = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  address?: string;
  petIds: string[];
  petCount?: number;
  loginEnabled?: boolean;
};
