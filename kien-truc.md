# Kiến trúc hệ thống

```mermaid
flowchart TB
    browser["Trình duyệt"]
    fe["<b>frontend (nginx)</b><br/>React build<br/><i>chặn /internal, /metrics, /health</i>"]
    s3[("<b>Blob S3</b><br/>ảnh y tế, Claim Check")]

    subgraph CORE["CORE"]
        direction TB
        api["<b>api</b><br/>login ký RS256, owner/pet, hotel,<br/>invoice, gateway proxy + circuit breaker"]
        outbox["<b>core-outbox</b><br/>relay sự kiện"]
        billing["<b>core-billing</b><br/>saga hóa đơn"]
    end

    subgraph CLINIC["CLINIC"]
        direction TB
        capi["<b>clinic-api</b><br/>lịch, bệnh án, ảnh, activity"]
        cworker["<b>clinic-worker</b><br/>relay + consumer + dọn ảnh"]
    end

    subgraph NOTI["NOTIFICATION"]
        direction TB
        napi["<b>notification-api</b>"]
        nworker["<b>notification-worker</b>"]
    end

    coredb[("Core DB")]
    clinicdb[("Clinic DB")]
    notidb[("Notification DB")]
    mq{{"<b>RabbitMQ</b> (exchange topic)<br/>outbox → publish → inbox, retry → DLQ"}}
    redis[("<b>Redis</b><br/>rate limit cho auth/public/ghi<br/>(GET đếm in-memory)")]

    %% Luồng HTTP đồng bộ
    browser -->|"/api/*"| fe
    fe --> api
    api -->|"HTTP proxy<br/>/appointments, /medical-records,<br/>/dashboard/clinic"| capi
    api -->|"HTTP proxy /notifications"| napi
    billing -->|"billing-source, prepare,<br/>commit / release"| capi
    capi -->|"directory authorize + lookup,<br/>billing evidence (token theo phạm vi)"| api
    cworker -->|"directory export"| api
    napi -->|"authorize-send"| api

    %% Lưu trữ
    CORE --> coredb
    CLINIC --> clinicdb
    NOTI --> notidb
    capi --> s3
    cworker -->|"dọn ảnh"| s3
    api -.->|"rate limit"| redis
    capi -.-> redis
    napi -.-> redis

    %% Truy cập ảnh trực tiếp bằng URL đã ký
    browser -.->|"URL ảnh đã ký (Valet Key)"| s3

    %% Sự kiện bất đồng bộ qua RabbitMQ
    outbox -.->|"publish"| mq
    cworker <-.->|"relay / consume"| mq
    mq -.->|"notification.requested<br/>identity.sessions-revoked"| nworker

    %% Màu sắc
    classDef svc fill:#EEEDFE,stroke:#534AB7,color:#26215C
    classDef store fill:#E1F5EE,stroke:#0F6E56,color:#04342C
    classDef edge fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
    class api,outbox,billing,capi,cworker,napi,nworker svc
    class coredb,clinicdb,notidb,s3,mq,redis store
    class browser,fe edge
```

Nét liền: HTTP đồng bộ (9 lời gọi, khai trong `deploy/phase2/service-calls.json`). Nét đứt: sự kiện qua RabbitMQ, rate limit, tải ảnh trực tiếp.

## Các cải tiến chính

| Việc                                   | Vấn đề trước đây                                                  | Cách làm                                                | Kết quả                                                                   |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Tách 3 service, mỗi service một DB** | Monolith dùng chung một DB, các phần dính vào nhau                | Core, Clinic, Notification; cấm đọc DB của service khác | Cái giá đo được so với monolith: p95 **×2,78**, CPU mỗi request **×4,72** |
| **Queue riêng cho thu hồi phiên**      | Lệnh khóa tài khoản xếp sau 500 thông báo, token cũ vẫn dùng được | Cho lệnh thu hồi một queue riêng                        | **4,4–5,8 s → 19–30 ms**                                                  |
| **Clinic hỏi Core 1 lần**              | Mỗi trang danh sách gọi Core 2 lần, Core đã gần quá tải           | Gộp thành 1 lần cho cả trang                            | p95 danh sách lịch **×0,603**                                             |
| **Claim Check cho ảnh**                | Ảnh lưu trong DB, danh sách nặng                                  | Ảnh ra bucket, trình duyệt tải bằng URL ký sẵn          | **800 KB → 1,9 KB**                                                       |
| **Gỡ CQRS**                            | Thêm bản đọc riêng nhưng tốn công giữ đồng bộ                     | Đo trước rồi mới quyết                                  | Chậm hơn **×1,25**, nên đã gỡ                                             |
| **Dọn cấu trúc code**                  | Code Clinic nằm ngoài các tầng; phụ thuộc ngược chiều tầng        | Chia tầng, thêm kiểm tự động                            | **1.840 → 247 dòng**; phụ thuộc ngược **16 → 0**                          |

Ghi chú: 800 KB → 1,9 KB làm tròn từ 800.106 → 1.870 byte. Số p95, CPU và ×0,603 đo trên VM FPT 8 vCPU, 100 user; ×1,25 đo trên Kaggle.
