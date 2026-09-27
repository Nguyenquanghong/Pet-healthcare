import unittest

from metrics import CpuSampler, appointment_slot


class MetricsTests(unittest.TestCase):
    def test_warmup_and_measurement_do_not_reuse_slots(self):
        warmup = {appointment_slot(i, "warmup") for i in range(3000)}
        measured = {appointment_slot(i, "measured") for i in range(3000)}
        self.assertEqual(len(warmup), 3000)
        self.assertEqual(len(measured), 3000)
        self.assertFalse(warmup & measured)

    def test_invalid_slot_rejected(self):
        with self.assertRaises(ValueError):
            appointment_slot(0, "invalid")

    def test_cpu_delta_and_multicore_usage(self):
        sampler = CpuSampler()
        self.assertIsNone(sampler.sample(10, {(1, 10): 5}))
        self.assertEqual(sampler.sample(12, {(1, 10): 8}), 150)
        self.assertEqual(sampler.sample(13, {(1, 10): 8}), 0)

    def test_process_churn_does_not_count_historical_cpu(self):
        sampler = CpuSampler()
        sampler.sample(10, {(1, 10): 5})
        self.assertEqual(sampler.sample(11, {(1, 11): 99}), 0)
        self.assertEqual(sampler.sample(12, {(1, 11): 99.5}), 50)


if __name__ == "__main__":
    unittest.main()
