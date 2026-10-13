"""PCN acceptance decisions. Short runs and missing evidence never become PASS."""
import math

PROTOCOL = "pet-healthcare-pcn-v1"
PCN_IDS = tuple(f"PCN{i:02d}" for i in range(1, 8))


def percentile(values, fraction=0.95):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)] if ordered else None


def load_verdict(data, *, kaggle):
    endpoints = data.get("endpoints", [])
    complete = (data.get("completed") is True and data.get("requests", 0) > 0
                and data.get("started_requests") == data.get("requests")
                and data.get("observed_user_min") == 100
                and data.get("observed_user_max") == 100
                and data.get("measured_seconds", 0) >= 1800
                and kaggle)
    if not complete:
        return {"PCN01": "PARTIAL", "PCN02": "PARTIAL"}
    required = {"GET pets", "GET appointments", "GET medical by pet", "GET hotel", "GET invoices",
                "GET notifications", "POST appointment", "POST rescue report"}
    present = {item["name"] for item in endpoints if item.get("requests", 0)}
    pcn01 = (required <= present and all(
        item.get("p95_ms") is not None and item["p95_ms"] <= 2000
        and item.get("within_2s_success_ratio", 0) >= 0.95 for item in endpoints))
    return {"PCN01": "PASS_IN_SCOPE" if pcn01 else "FAIL",
            "PCN02": "PASS_IN_SCOPE" if data.get("error_rate", 1) <= 0.01 else "FAIL"}


def report(load=None, security=None, browser=None, restart=None, backup=None, *, kaggle=False):
    rows = {key: {"status": "NOT_RUN"} for key in PCN_IDS}
    if load:
        for key, status in load_verdict(load, kaggle=kaggle).items():
            rows[key] = {"status": status, "evidence": "load-final.json",
                         "scope": "Các API đọc, lọc theo thú cưng và ghi trong workload; không đo mọi hành trình người dùng."}
    if security:
        rows["PCN03"] = {"status": "PASS_IN_SCOPE" if security.get("passed") is True else "FAIL",
                         "evidence": "security.json", "scope": "Toàn bộ tài khoản trong DB thử và ma trận truy cập được liệt kê."}
    if browser:
        for key in ("PCN04", "PCN05"):
            rows[key] = {"status": browser.get(key, {}).get("status", "NOT_RUN"),
                         "evidence": "browser.json", "scope": browser.get(key, {}).get("scope", "")}
    if restart:
        rows["PCN06"] = {"status": "PASS_IN_SCOPE" if restart.get("passed") is True
                         and restart.get("count") == 20 else "FAIL",
                         "evidence": "restart.json", "scope": "20 hồ sơ thú cưng tạo qua API; khởi động lại cả API và PostgreSQL."}
    if backup:
        lab_passed = (backup.get("restore_passed") is True and backup.get("restore_seconds", 1801) <= 1800
                      and backup.get("retained_backups") == 7)
        rows["PCN07"] = {"status": "PARTIAL" if lab_passed else "FAIL", "evidence": "backup.json",
                         "scope": "Đã thử giữ 7 bản sao và khôi phục DB. Chưa quan sát lịch sao lưu hằng ngày trong 7 ngày vận hành."}
    return {"protocol": PROTOCOL, "requirements": rows,
            "overall": "FAIL" if any(x["status"] == "FAIL" for x in rows.values()) else "PARTIAL",
            "note": "PASS_IN_SCOPE chỉ xác nhận phạm vi đã chạy. Chưa có PASS toàn bộ vì lịch sao lưu hằng ngày cần bằng chứng vận hành."}
