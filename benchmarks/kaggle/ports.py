"""Check the runner's loopback ports without mistaking TIME_WAIT for a server."""

import socket


def require_free_port(port):
    # On POSIX, create_server enables SO_REUSEADDR for closed TCP connections.
    # Keep reuse_port=False: an existing listener must still stop this runner.
    # The probe closes immediately; pg_ctl/API startup remains authoritative.
    try:
        with socket.create_server(("127.0.0.1", port), reuse_port=False):
            pass
    except OSError as error:
        raise RuntimeError(
            f"Cannot listen on benchmark port 127.0.0.1:{port}: {error}. "
            "Inspect the existing listener or start a fresh Kaggle session; "
            "do not run benchmark matrices concurrently."
        ) from error
