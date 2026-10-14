#!/usr/bin/python3
"""Fixed libseccomp policy for the Apple-container probe, not a sandbox API.

Executed after util-linux unshare/setpriv, before any candidate code. The kernel
inherits the loaded filter across fork/exec. Missing policy support is fatal.
"""
import ctypes
import errno
import os
import sys


class Comparison(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]


lib = ctypes.CDLL("libseccomp.so.2")
lib.seccomp_init.argtypes = [ctypes.c_uint32]
lib.seccomp_init.restype = ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                     ctypes.c_int, ctypes.c_uint,
                                     ctypes.POINTER(Comparison)]
lib.seccomp_load.argtypes = [ctypes.c_void_p]
lib.seccomp_release.argtypes = [ctypes.c_void_p]
ctx = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
if not ctx:
    raise RuntimeError("seccomp_init failed")


def deny(name, comparisons=None):
    number = lib.seccomp_syscall_resolve_name(name.encode())
    if number < 0:
        raise RuntimeError("unrecognized syscall: " + name)
    count = 0 if comparisons is None else len(comparisons)
    if lib.seccomp_rule_add_array(ctx, 0x00050000 | errno.EPERM,
                                 number, count, comparisons) != 0:
        raise RuntimeError("seccomp rule failed: " + name)


# Only AF_UNIX (1) sockets within this VM/network namespace are permitted.
# This explicitly closes AF_VSOCK, IPv4/6, packet, netlink and new families.
for call in ("socket", "socketpair"):
    deny(call, (Comparison * 1)(Comparison(0, 1, 1, 0)))  # SCMP_CMP_NE
# Prevent namespace re-entry and alternate I/O/control paths after bootstrap.
for call in ("setns", "unshare", "ptrace", "process_vm_readv",
             "process_vm_writev", "pidfd_getfd", "bpf", "io_uring_setup"):
    deny(call)
if lib.seccomp_load(ctx) != 0:
    raise RuntimeError("seccomp_load failed")
lib.seccomp_release(ctx)
if os.getuid() != 1000 or os.getgid() != 1000:
    raise RuntimeError("unexpected execution identity")
os.execvp(sys.argv[1], sys.argv[1:])
