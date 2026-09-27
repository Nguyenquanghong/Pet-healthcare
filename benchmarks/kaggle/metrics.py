"""Pure helpers shared by the workload and resource sampler."""

from datetime import date, timedelta


def appointment_slot(number, phase):
    if phase not in ("warmup", "measured") or number < 0:
        raise ValueError("Invalid workload phase or appointment number")
    # Disjoint days prevent warmup writes from colliding with measured writes.
    day = date(2099, 1, 1) + timedelta(days=(number // 1440) * 2 + (phase == "measured"))
    minute = number % 1440
    return day.isoformat(), f"{minute // 60:02d}:{minute % 60:02d}"


class CpuSampler:
    """CPU-seconds delta / wall time; 100% means one core, not the whole host.

    First sample is unknown. Short-lived processes between polls are not captured.
    Process keys include creation time to avoid treating a reused PID as one process.
    """

    def __init__(self):
        self.previous = None

    def sample(self, now, cpu_times):
        previous = self.previous
        self.previous = (now, cpu_times)
        if previous is None or now <= previous[0]:
            return None
        delta = sum(max(0, value - previous[1][key]) for key, value in cpu_times.items() if key in previous[1])
        return 100 * delta / (now - previous[0])
