# Nguồn và phạm vi kiểm chứng

Ngày tham khảo: 11/10/2026. Nguồn được dùng cho quyết định thiết kế; các thông số vận hành vẫn cần kiểm chứng với phiên bản dependency được chốt lúc triển khai.

## Nguồn code trong repo

| File/ref đã đọc                                                                                         | Bằng chứng                                                                    |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `backend/src/legacy/app.ts`                                                                             | Wiring, auth limiter chung và thứ tự lists router trước write routers         |
| `backend/src/lib/password.ts`, `infrastructure/security/authAdapters.ts`                                | HTTP dùng PBKDF2 async; iterations 210.000                                    |
| `backend/src/middleware/auth.ts`, `lib/token.ts`                                                        | JWT xác minh cục bộ; secret chung và expiry mặc định 8h                       |
| `backend/src/legacy/application/services/appointments.ts`                                               | Clinic và Spa cùng loại appointment; scope, slot, lifecycle                   |
| `backend/src/legacy/application/services/medicalRecords.ts`, `legacy/infrastructure/persistence/medicalRepository.ts` | Bệnh án và appointment completion cùng unit of work                           |
| `backend/src/infrastructure/persistence/bookingLifecycleRepository.ts`                                  | Row lock, dependency invoice/medical và history                               |
| `backend/src/application/services/invoices.ts`, `infrastructure/persistence/invoiceRepository.ts`       | Nguồn hóa đơn, giá, lock appointment, unique source                           |
| `backend/src/infrastructure/persistence/listsRepository.ts`                                             | Filter/count/pagination/related và join liên miền                             |
| `backend/prisma/schema.prisma`, migration `20260927000000_active_appointment_slot`                      | Các model/FK và partial unique pet/date/time                                  |
| `frontend/src/store/AppStoreProvider.tsx`                                                               | Bootstrap polling, /auth/me restore, save/refresh                             |
| `package.json`, `backend/package.json`, `playwright.config.ts`                                          | Script thật và điều kiện chạy test                                            |
| `refactor:139e4dd`                                                                                      | Refresh/page fixes cần review khi port                                        |
| `experiment/phase2-notification-service:c5736ed`                                                        | Contract/harness tiền đề, chưa runtime độc lập                                |
| `migration/spring-boot:6c50736`                                                                         | Java migration, bootstrap vẫn tải collection; không là nền tích hợp được chọn |

Git refs quan sát cục bộ, không fetch xác minh phiên bản server. Nghiên cứu này không thực hiện benchmark hoặc xác nhận toàn bộ test baseline đạt.

## Nguồn kỹ thuật

- [Microservice Architecture — Chris Richardson](https://microservices.io/patterns/microservices.html): triển khai độc lập và đánh đổi của giao dịch xuyên dịch vụ.
- [Database per service](https://microservices.io/patterns/data/database-per-service.html): quyền sở hữu dữ liệu và khả năng dùng hạ tầng DB chung với quyền tách biệt.
- [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html): ghi sự kiện cùng transaction, relay có thể gửi lặp nên consumer phải idempotent.
- [RabbitMQ — Consumer acknowledgements and publisher confirms](https://www.rabbitmq.com/docs/confirms): phân biệt broker confirm và consumer ACK. Cấu hình retry/DLQ phải đối chiếu phiên bản broker dùng thực tế.
- [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html): khóa hàng và SKIP LOCKED; triển khai phải đối chiếu PostgreSQL đang dùng, không dùng tài liệu current để tự nâng DB.
- [Node.js Crypto / PBKDF2](https://nodejs.org/api/crypto.html#cryptopbkdf2password-salt-iterations-keylen-digest-callback): API bất đồng bộ dùng libuv threadpool.
- [express-rate-limit Overview](https://github.com/express-rate-limit/express-rate-limit/blob/main/docs/overview.mdx): MemoryStore không chia sẻ counter giữa process/server.
