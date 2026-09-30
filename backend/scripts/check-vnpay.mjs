import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
config({ path: envFile, quiet: true });
console.log("Kiểm tra cấu hình VNPay Sandbox (không gửi giao dịch).");
if (process.env.VNPAY_ENABLED !== "true") {
  console.log("VNPay đang tắt: pha 1 dùng chuyển khoản thủ công và thanh toán tại cửa hàng.");
  console.log("Khi triển khai pha sau, đặt VNPAY_ENABLED=true rồi kiểm tra lại.");
  process.exit(0);
}
console.log(existsSync(envFile) ? "Đã tìm thấy backend/.env." : "Chưa có backend/.env; có thể cấu hình bằng biến môi trường.");

const tmnCode = process.env.VNPAY_TMN_CODE || "";
const secret = process.env.VNPAY_HASH_SECRET || "";
const returnUrl = process.env.VNPAY_RETURN_URL || "";
let failed = false;
function check(ok, label, fix) {
  console.log(`${ok ? "OK" : "THIẾU/SAI"}: ${label}`);
  if (!ok) { failed = true; console.log(`  ${fix}`); }
}
// Print only validation results: never values, signed URLs, or secret lengths.
check(/^[A-Z0-9]{8}$/i.test(tmnCode), "VNPAY_TMN_CODE", "Điền mã website 8 ký tự do VNPay Sandbox cấp.");
check(secret.length >= 16 && !/[<>]/.test(secret), "VNPAY_HASH_SECRET", "Điền khóa do VNPay cấp vào backend/.env, không gửi trong chat hoặc đưa lên Git.");
let parsed;
try { parsed = new URL(returnUrl); } catch {}
const validReturn = parsed && !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
  parsed.pathname === "/owner/billing" &&
  (parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)));
check(Boolean(validReturn), "VNPAY_RETURN_URL", "Dùng URL frontend kết thúc /owner/billing; ví dụ http://localhost:5173/owner/billing.");
if (parsed && ["localhost", "127.0.0.1"].includes(parsed.hostname))
  console.log("Return URL local dùng được khi trình duyệt thanh toán đang chạy trên cùng máy.");
console.log("IPN: đăng ký URL HTTPS công khai kết thúc /api/payments/vnpay/ipn với VNPay.");
console.log("Lệnh này không xác minh khóa với VNPay, kết nối database hoặc khả năng nhận IPN từ Internet.");
console.log(failed ? "Chưa đủ cấu hình. Xem VNPAY_SANDBOX.md ở thư mục gốc." : "Định dạng cấu hình đạt. Khởi động lại backend rồi kiểm tra một giao dịch Sandbox theo VNPAY_SANDBOX.md.");
process.exitCode = failed ? 1 : 0;
