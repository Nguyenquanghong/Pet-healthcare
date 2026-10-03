"""Check the runner's loopback ports without mistaking TIME_WAIT for a server."""

import socket
import os


def require_free_port(port):
    # On POSIX, create_server enables SO_REUSEADDR for closed TCP connections.
    # Keep reuse_port=False: an existing listener must still stop this runner.
    # The probe closes immediately; pg_ctl/API startup remains authoritative.
    try:
        if os.name == "nt":
            # Windows permits overlapping wildcard/loopback binds unless the
            # probe claims the wildcard address exclusively. An exclusive
            # loopback bind alone can still coexist with a wildcard listener.
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                probe.bind(("0.0.0.0", port))
                probe.listen(1)
        else:
            with socket.create_server(("127.0.0.1", port), reuse_port=False):
                pass
    except OSError as error:
        raise RuntimeError(
            f"Cannot listen on benchmark port 127.0.0.1:{port}: {error}. "
            "Inspect the existing listener or start a fresh Kaggle session; "
            "do not run benchmark matrices concurrently."
        ) from error
