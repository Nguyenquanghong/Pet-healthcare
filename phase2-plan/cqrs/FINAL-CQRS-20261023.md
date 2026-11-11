# Chốt CQRS — danh sách lịch hẹn (23/10/2026)

Trạng thái: **CHỐT**. Quyết định kiến trúc: [ADR-CQRS-06](evidence/adr-cqrs-06.md).

Bản cuối (F) đã được đo so với O trên Kaggle (study `cqrs-final-matched-kaggle-v1`). Theo policy đóng băng, kết quả là `FAIL_CORRECTNESS`; lỗi nằm ở baseline O, không phải F. Tính không regression chưa chứng minh được theo luật đã đóng băng, vì môi trường Kaggle chậm dần trong phiên (xem [Đo bản cuối](#đo-bản-cuối-so-với-o-kaggle)). Ước lượng cân bằng thứ tự (phân tích khám phá, không phải gate) cho F/O khoảng 1,0.

## Quyết định

Danh sách và lịch lịch hẹn đọc trực tiếp bảng nguồn. Bảo trì projection (registry `ClinicReadRevision`, event `clinic.appointment-read-changed.v1`, projector) tắt mặc định bằng `CLINIC_READ_PROJECTION=off`. Toàn bộ code CQRS được giữ để bật lại (`on`); khi bật lại phải rebuild trước.

## Vì sao

| Nguồn                                        | Kết quả                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Study v1 (K2, K3)                            | `FAIL_CORRECTNESS` ở block 0. Hai lỗi kiến trúc tìm được, đã sửa                                                                                                                                                                                                                                                                                          |
| K2v2 query-heavy (77fe0569, 3 block, hợp lệ) | Đọc projection (B) chậm hơn đọc nguồn (A) 25%: B/A median 1,25, gate ≤ 0,80 FAIL; B/O 1,29; owner-calendar B/O 1,69. CPU/success và throughput PASS. B/A giữ khoảng 1,25 ở cả 3 vòng xoay thứ tự (1,229 / 1,29 / 1,25), nên không phải do thứ tự chạy                                                                                                     |
| K3v2 PCN (fd95963d)                          | Hai lỗi harness/ước lượng đã sửa. Một block, thứ tự O→A→B: A chậm hơn O 1,5–1,8× ở mọi endpoint, CPU app A/O 1,11. **Đọc lại sau đo cuối:** con số này bị thổi phồng bởi hiệu ứng thứ tự (member chạy sau chậm hơn 10–25% trên Kaggle, kể cả endpoint chỉ qua Core: GET pets O 43, A 67, B 73 ms). CPU app A/O 1,11 vẫn là chi phí thật của phần ghi CQRS |
| Thí nghiệm local slot admission              | 2 slot chỉ giảm owner-list khoảng 30%; primary admin-list không đổi (B1/A 1,07, B2/A 1,08). Nguyên nhân gốc: truy vấn projection vẫn JOIN bảng nguồn để kiểm ACL                                                                                                                                                                                          |

Projection không rẻ hơn đọc nguồn khi ACL buộc phải JOIN nguồn, trong khi phần ghi tốn thêm CPU liên tục. Gate chính không đạt và không đổi ngưỡng sau khi có kết quả. Quyết định dựa vào K2v2 B/A, nên vẫn đứng khi bỏ con số K3v2.

## Lỗi kiến trúc tìm được nhờ study và đã sửa

| Lỗi                                                                                                             | Phát hiện ở      | Sửa                                                                                      |
| --------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| Relay outbox Clinic một event một kết nối, trần khoảng 27 event/s, outbox chạm 20000 và ghi trả 503             | K3 v1            | Relay theo lô trên kết nối bền (khoảng 1350 event/s); Core dùng chung `ConfirmPublisher` |
| Trần statement 200 ms cho truy vấn projection làm fallback toàn query và pool đầy                               | K2 v1            | Trần theo budget còn lại, tối đa 1000 ms                                                 |
| Ước lượng lag của danh sách cộng dồn khi ghi đều (`freshness_lag`, 972 lỗi 503)                                 | K3v2             | Ước lượng theo aggregate (`perAggregateLag`)                                             |
| Giới hạn một IP 3000 đọc/phút làm 429 hàng loạt khi benchmark                                                   | K3v2             | Chỉ patch bundle study, code repo không đổi                                              |
| Grant runtime P7 thiếu SELECT cho `AppointmentQueryEpoch` (sau cutover mọi đọc projection sẽ lỗi hoặc fallback) | Rule fitness mới | Thêm SELECT; rule `runtime-grants-cover-every-model`                                     |

## Đo bản cuối so với O (Kaggle)

- **Study:** `cqrs-final-matched-kaggle-v1`, policy-2 `80df7faa…` (đóng băng trước khi đo).
- **Hai cấu hình:**
  - O: bản trước CQRS `3e88d7e`.
  - F: bundle v13 `e7180abd…`, HEAD `ae6748d`, projection `off`, không projector, đọc authoritative.
- **Phạm vi:** F/O so mọi thay đổi kể từ `3e88d7e`, không chỉ công tắc CQRS. Gồm cả Circuit Breaker, kiểm phiên AQ-05 và Claim Check AQ-09.
- **Gate:** từng block phải đạt p95 ≤ 1,10, CPU/success ≤ 1,10, throughput ≥ 0,90.
- **Thứ tự chạy:** O,F | F,O | O,F.
- **Kiểm dữ liệu:** cả hai phiên khớp manifest 58/58 và 68/68 file, không secret, policy và overlay khớp repo, cùng profileKey `bcb175bb…`.
- **Evidence (local only):** `phase2-plan/cqrs/final/kf-qh-cd65abcb/`, `kf-pcn-7acfa9a1/`, `combine-final-20261023.json`.

**Kết quả theo policy**

| Workload                          | Kết quả                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query-heavy (`cd65abcb`, 3 block) | 6/6 member đúng, 0 lỗi, F không fallback. Primary admin-list F/O 1,102 / 0,890 / 1,185, nên FAIL. Calendar PASS. Throughput 1,0 PASS. CPU/success 0,966 / 1,004, thiếu block 0 (một tiến trình con của generator thoát khỏi cây pid), nên `TOTAL_COST_INCONCLUSIVE`                                                                                                   |
| PCN (`7acfa9a1`, dừng ở b1)       | b0: F/O 1,20–1,33 ở mọi endpoint, CPU/success 1,012, throughput 0,996. b1: O sai, có 1 lịch hẹn trong DB không có phản hồi 201 tương ứng. Cả 24 873 POST trong cửa sổ đo đều trả 201, 0 failure, nên dòng ghi này phát sinh ngoài cửa sổ (ramp/warmup hoặc lúc dừng generator). Dữ liệu export không đủ để xác định nguyên nhân. F đúng ở cả hai block. b2 không chạy |
| Cả study                          | `FAIL_CORRECTNESS` (từ O). Không ra được `NO_REGRESSION`                                                                                                                                                                                                                                                                                                              |

**Hiệu ứng thứ tự.** Block nào F chạy sau thì fail; block nào F chạy trước thì pass.

| p95 theo vị trí chạy (ms)   | 1      | 2      | 3      | 4       | 5      | 6      |
| --------------------------- | ------ | ------ | ------ | ------- | ------ | ------ |
| Query-heavy admin-list      | O 77,9 | F 85,9 | F 75,1 | O 84,4  | O 76,6 | F 90,8 |
| PCN GET pets (chỉ qua Core) | O 33,7 | F 42,2 | F 42,2 | O 50,9  |        |        |
| PCN GET appointments        | O 70,1 | F 86,2 | F 88,6 | O 105,9 |        |        |

- PCN chậm dần theo thời gian ở mọi endpoint. Query-heavy: member thứ hai của mỗi block chậm hơn khoảng 13% ở admin-list.
- Độ trôi 10–25% mỗi member lớn hơn biên 10%. Với 2–3 block và luật chấm "mọi cặp ≤ 1,10", study không phân biệt được một regression nhỏ hơn 10%, theo cả hai chiều.

**Ước lượng cân bằng thứ tự (khám phá, không phải gate)**

| Workload                                                        | F/O                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Query-heavy, mô hình log-ratio "hiệu ứng ± vị trí" trên 3 block | admin-list 1,008; mọi operation 0,87–1,045                                                        |
| PCN, O-F-F-O (chỉ triệt tiêu trôi tuyến tính, 2 block)          | GET appointments 1,014; POST appointment 1,055; POST rescue report 0,985; các đọc khác 1,007–1,09 |

Số liệu nhất quán với "F không chậm hơn O", nhưng chưa phải chứng minh. Muốn có kết luận chính thức cần policy mới tách được độ trôi (xen kẽ O/F ngắn trong mỗi block) và một lượt Kaggle khoảng 5 giờ. Không chạy, vì quyết định ở trên không phụ thuộc con số này.

## Bản cuối

- Bước 1 đã commit `46adce9` (công tắc, test, harness). Kiểm chứng:
  - cqrs unit 80/80, activity unit 73/73;
  - projector/rebuild/read-path/fault PASS với `on`;
  - phase2 clinic/integration/billing/notification-runtime/resilience/migration PASS;
  - `arch:check` 7/7, E2E 18/18, activity E2E PASS.
- Bản được đo (F, HEAD `ae6748d`) có thêm:
  - AQ-09: `ac1b8ef`, `f12537a`, `2b2a068`;
  - parity: `dc65c10`;
  - Circuit Breaker Clinic→Core: `a7df0a5`;
  - AQ-05 Notification: `ae6748d`.
- Sau khi đo chỉ có E-c `6fc7af4` (QR ở frontend), không nằm trên đường request được đo.

## Còn mở

- Kết luận chính thức "F không chậm hơn O" cần study mới có thiết kế chống trôi (không chạy).
- Harness PCN: ledger ghi chỉ lưu id khi nhận được 201, nên một request ghi bị cắt lúc dừng generator thành `writes_without_success_response`. Muốn phân biệt, cần lưu khóa request trước khi gửi và export log của generator.
- Study v3 đã sẵn sàng nhưng không chạy.
- Activity dashboard (daily summary V2) vẫn là phần read model còn lại; chỉ dùng khi `on`, mặc định đọc nguồn.
