"""Live TCP regressions for the repeated-run port check, with no database."""

import errno
import socket
import sys
import unittest

from ports import require_free_port


class PortTests(unittest.TestCase):
    def test_free_port_can_be_probed_repeatedly_and_remains_available(self):
        with socket.create_server(("127.0.0.1", 0)) as server:
            port = server.getsockname()[1]
        for _ in range(20):
            require_free_port(port)
        with socket.create_server(("127.0.0.1", port)):
            pass

    def test_existing_listener_is_rejected_and_remains_running(self):
        for address in ("127.0.0.1", "0.0.0.0"):
            with self.subTest(address=address), socket.create_server((address, 0)) as server:
                port = server.getsockname()[1]
                with self.assertRaisesRegex(RuntimeError, str(port)):
                    require_free_port(port)
                server.settimeout(2)
                with socket.create_connection(("127.0.0.1", port), timeout=2):
                    connection, _ = server.accept()
                    connection.close()

    def test_bound_port_without_reuse_is_rejected(self):
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            with self.assertRaisesRegex(RuntimeError, str(reserved.getsockname()[1])):
                require_free_port(reserved.getsockname()[1])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Reproduce Kaggle TCP TIME_WAIT on Linux")
    def test_time_wait_reproduces_old_error_but_allows_the_next_run(self):
        with socket.create_server(("127.0.0.1", 0)) as server:
            port = server.getsockname()[1]
            server.settimeout(2)
            with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
                accepted, _ = server.accept()
                with accepted:
                    accepted.settimeout(2)
                    # Server sends FIN first, so TIME_WAIT belongs to its port.
                    accepted.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b"")
                    client.shutdown(socket.SHUT_WR)
                    self.assertEqual(accepted.recv(1), b"")
        with socket.socket() as old_probe:
            with self.assertRaises(OSError) as caught:
                old_probe.bind(("127.0.0.1", port))
            self.assertEqual(caught.exception.errno, errno.EADDRINUSE)
        for _ in range(20):
            require_free_port(port)
        with socket.create_server(("127.0.0.1", port)):
            pass


if __name__ == "__main__":
    unittest.main()
