"""Run media tools, optionally inside a fail-closed per-job bubblewrap sandbox."""
import os
from pathlib import Path
import subprocess


def sandbox_command(program, args, directory, binaries, sandbox):
    return [sandbox, "--unshare-all", "--new-session", "--die-with-parent", "--cap-drop", "ALL",
            "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
            "--setenv", "HOME", "/nonexistent", "--ro-bind", "/usr/bin", "/usr/bin",
            "--ro-bind", "/usr/lib", "/usr/lib",
            "--ro-bind", "/lib", "/lib", "--ro-bind", str(binaries), "/runtime",
            "--dir", "/proc", "--dev", "/dev",
            "--tmpfs", "/tmp",  # nosec B108: private sandbox tmpfs, not the shared host directory.
            "--bind", str(directory), "/work", "--chdir", "/work", "--", program, *args]


def run(args, *, directory, **kwargs):
    tool = str(args[0])
    if tool not in ("ffmpeg", "ffprobe"):
        raise ValueError("Only FFmpeg and FFprobe are media workers")
    directory = Path(directory).resolve(strict=True)
    configured = os.environ.get("CUE_MEDIA_BIN")
    sandbox = os.environ.get("CUE_BWRAP")
    if sandbox and not configured:
        raise ValueError("CUE_BWRAP requires a pinned CUE_MEDIA_BIN; refusing fallback")
    if configured:
        binaries = Path(configured).resolve(strict=True)
        program = binaries / tool
        if not program.is_file() or not os.access(program, os.X_OK):
            raise ValueError("Configured media tool is missing; refusing fallback")
    else:
        program = tool
    values = [str(value) for value in args[1:]]
    if sandbox:
        translated = []
        for value in values:
            if value.startswith("/"):
                # Both input and output files must stay inside this one job directory.
                relative = Path(value).resolve().relative_to(directory)
                value = str(Path("/work") / relative)
            translated.append(value)
        command = sandbox_command(f"/runtime/{tool}", translated, directory, binaries, sandbox)
    else:
        command = [str(program), *values]
    return subprocess.run(command, **kwargs)
