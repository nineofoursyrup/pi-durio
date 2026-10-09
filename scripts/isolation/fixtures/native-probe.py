import json
import os
import socket
import subprocess
import ctypes
import platform

results = []


def attempt(name, operation):
    try:
        value = operation()
        if hasattr(value, "close"):
            value.close()
        results.append({"name": name, "blocked": False})
    except OSError as error:
        results.append({"name": name, "blocked": error.errno in (1, 13), "errno": error.errno})


for family, name in [(2, "ipv4_socket"), (10, "ipv6_socket"),
                     (40, "vsock_control_socket"), (16, "netlink_socket"),
                     (17, "packet_socket")]:
    attempt(name, lambda family=family: socket.socket(family, socket.SOCK_STREAM))
attempt("restore_root", lambda: os.setuid(0))
# PID 1 in this container is the candidate itself, not the host controller.
# Probe the prohibited process syscalls even against self, and separately
# inspect the visible init identity rather than mistaking self-access for escape.
libc = ctypes.CDLL(None, use_errno=True)
seccomp = ctypes.CDLL("libseccomp.so.2")
seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]


def syscall(name, *args):
    number = seccomp.seccomp_syscall_resolve_name(name.encode())
    if libc.syscall(number, *args) == -1:
        raise OSError(ctypes.get_errno(), name)


attempt("ptrace_process_channel", lambda: syscall("ptrace", 0, 0, 0, 0))
attempt("process_vm_read_channel", lambda: syscall("process_vm_readv", os.getpid(), 0, 0, 0, 0, 0))
entered = subprocess.run(["/usr/bin/unshare", "--net", "/bin/true"], capture_output=True)
results.append({"name": "new_network_namespace", "blocked": entered.returncode != 0,
                "code": entered.returncode, "stderr": entered.stderr.decode().strip()})
print(json.dumps({"results": results, "uid": os.getuid(), "gid": os.getgid(),
                  "kernel": platform.release(), "architecture": platform.machine(),
                  "packages": subprocess.check_output(["dpkg-query", "-W", "python3", "libseccomp2", "util-linux"], text=True),
                  "status": open("/proc/self/status").read(),
                  "initCommand": open("/proc/1/cmdline", "rb").read().decode().replace("\x00", " "),
                  "networkDevices": open("/proc/net/dev").read()}))
