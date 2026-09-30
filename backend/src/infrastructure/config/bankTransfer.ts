import type { BankTransferDetails } from "../../application/ports/invoices.js";

export function bankTransferConfig(env: Record<string, string | undefined>): BankTransferDetails | null {
  if (env.BANK_TRANSFER_DEMO !== "false") return {
    bankName: "Ngân hàng minh họa", accountNumber: "0000000000",
    accountHolder: "NIPOPETO DEMO", isDemo: true,
  };
  const bankName = env.BANK_TRANSFER_BANK_NAME?.trim();
  const accountNumber = env.BANK_TRANSFER_ACCOUNT_NUMBER?.trim();
  const accountHolder = env.BANK_TRANSFER_ACCOUNT_HOLDER?.trim();
  const bankBin = env.BANK_TRANSFER_BANK_BIN?.trim();
  if (!bankName || bankName.length > 100 || !accountHolder || accountHolder.length > 100 ||
    !accountNumber || !/^[0-9]{6,19}$/.test(accountNumber) || !bankBin || !/^[0-9]{6}$/.test(bankBin)) return null;
  return { bankName, bankBin, accountNumber, accountHolder, isDemo: false };
}
