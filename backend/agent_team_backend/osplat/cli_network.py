"""Bounded numeric established-TCP observations; no reverse DNS or traffic capture."""

from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import time
from dataclasses import dataclass

MAX_PIDS = 4096
MAX_OUTPUT = 4 * 1024 * 1024
COMMAND_TIMEOUT = 4.0
CLEANUP_TIMEOUT = 0.5


@dataclass(frozen=True)
class Connection:
    pid: int
    ip: str
    port: int


@dataclass(frozen=True)
class NetworkSample:
    status: str
    connections: tuple[Connection, ...] = ()


def endpoint(value: str) -> tuple[str, int]:
    address, port_text = value.rsplit(":", 1)
    address = address.strip("[]")
    # A scope identifier is interface-local, not part of the IP allow identity.
    address = address.split("%", 1)[0]
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    port = int(port_text)
    if not 0 < port <= 65535:
        raise ValueError("invalid remote port")
    return str(ip), port


async def command(argv: list[str]) -> tuple[int, str, str]:
    """Limit elapsed time and both pipes, and reap a cancelled/timed-out child."""
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )

    async def read(stream: asyncio.StreamReader) -> str:
        data = bytearray()
        while chunk := await stream.read(65536):
            data.extend(chunk)
            if len(data) > MAX_OUTPUT:
                raise ValueError("socket output exceeds limit")
        return data.decode("utf-8", errors="strict")

    tasks = [asyncio.create_task(read(proc.stdout)), asyncio.create_task(read(proc.stderr)),
             asyncio.create_task(proc.wait())]
    try:
        async with asyncio.timeout(COMMAND_TIMEOUT):
            stdout, stderr, code = await asyncio.gather(*tasks)
        return code, stdout, stderr
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        for task in tasks:
            task.cancel()
        try:
            async with asyncio.timeout(CLEANUP_TIMEOUT):
                await asyncio.gather(*tasks, return_exceptions=True)
                await proc.wait()
        except TimeoutError:
            # An inherited open pipe can keep asyncio's wait pending after
            # SIGKILL. Close that transport rather than wedging every sweep.
            transport = getattr(proc, "_transport", None)
            if transport is not None:
                transport.close()


def parse_lsof(output: str, pids: set[int]) -> tuple[Connection, ...]:
    result = []
    pid = None
    for line in output.splitlines():
        if not line:
            continue
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n"):
            if pid is None or "->" not in line:
                raise ValueError("incomplete lsof attribution")
            ip, port = endpoint(line[1:].split("->", 1)[1])
            if pid in pids:
                result.append(Connection(pid, ip, port))
        elif line[0] not in "fPT":
            raise ValueError("unrecognised lsof record")
    return tuple(result)


def parse_ss(output: str, pids: set[int], socket_owners: dict[int, set[int]] | None = None) -> tuple[Connection, ...]:
    result = []
    for line in output.splitlines():
        if not line.strip() or line.startswith(("State", "Recv-Q")):
            continue
        fields = line.split()
        if fields[0] in ("ESTAB", "ESTABLISHED"):
            fields = fields[1:]
        if len(fields) < 4:
            raise ValueError("incomplete ss row")
        # With `state established`, ss may omit the State column.
        ip, port = endpoint(fields[3])
        owners = {int(value) for value in re.findall(r"pid=(\d+)", line)}
        inode = re.search(r"\bino:(\d+)\b", line)
        if not owners:
            if socket_owners is None or inode is None or int(inode[1]) == 0:
                raise ValueError("ss did not report socket ownership")
        if socket_owners is not None and inode is not None:
            # Include partially reported shared sockets too. These before/after
            # inventories are samples: a transfer entirely between them can
            # still be missed, just like a connection between resource polls.
            owners.update(socket_owners.get(int(inode[1]), set()))
        for pid in sorted(owners & pids):
            result.append(Connection(pid, ip, port))
    return tuple(result)


def owned_socket_inodes(pids: set[int]) -> dict[int, set[int]]:
    result: dict[int, set[int]] = {}
    count = 0
    deadline = time.monotonic() + 2.0
    for pid in pids:
        try:
            with os.scandir(f"/proc/{pid}/fd") as entries:
                for entry in entries:
                    count += 1
                    if count > 100_000 or time.monotonic() >= deadline:
                        raise ValueError("owned socket inventory exceeds budget")
                    try:
                        target = os.readlink(entry.path)
                    except FileNotFoundError:
                        continue  # A descriptor closed between directory and link reads.
                    match = re.fullmatch(r"socket:\[(\d+)\]", target)
                    if match:
                        result.setdefault(int(match[1]), set()).add(pid)
        except FileNotFoundError:
            continue  # A requested process exited before collection.
    return result


async def collect_lsof(pids: list[int]) -> NetworkSample:
    unique = set(pids)
    if not unique:
        return NetworkSample("successful")
    if len(unique) > MAX_PIDS or any(pid <= 0 for pid in unique):
        return NetworkSample("unknown")
    try:
        code, output, error = await command([
            "lsof", "-nP", "-iTCP", "-sTCP:ESTABLISHED", "-a", "-p",
            ",".join(map(str, sorted(unique))), "-Fpn",
        ])
        # lsof returns 1 for an empty selection; diagnostics still mean unknown.
        if error.strip() or code not in (0, 1) or (code == 1 and output.strip()):
            return NetworkSample("unknown")
        return NetworkSample("successful", parse_lsof(output, unique))
    except (OSError, ValueError, TimeoutError):
        return NetworkSample("unknown")


async def collect_ss(pids: list[int]) -> NetworkSample:
    unique = set(pids)
    if not unique:
        return NetworkSample("successful")
    if len(unique) > MAX_PIDS or any(pid <= 0 for pid in unique):
        return NetworkSample("unknown")
    try:
        owners = await asyncio.to_thread(owned_socket_inodes, unique)
        code, output, error = await command(["ss", "-tnpe", "state", "established"])
        if code or error.strip():
            return NetworkSample("unknown")
        after = await asyncio.to_thread(owned_socket_inodes, unique)
        for inode, pids_after in after.items():
            owners.setdefault(inode, set()).update(pids_after)
        return NetworkSample("successful", parse_ss(output, unique, owners))
    except (OSError, ValueError, TimeoutError):
        return NetworkSample("unknown")


async def unsupported(pids: list[int]) -> NetworkSample:
    return NetworkSample("unsupported")
