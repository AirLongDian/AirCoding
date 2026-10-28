"""Unattended local Understand evaluation using a preinstalled licensed runtime.

The CLI command shape is taken from UndBuilder.java in stinb/understand-jenkins-plugin.
This path has NOT been executed against Understand 8.0 in the cloud.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--und", default="und", help="Understand CLI executable")
    parser.add_argument("--upython", default="upython", help="Matching Understand Python executable")
    parser.add_argument("--cmake", default="cmake")
    parser.add_argument("--generator", default="Ninja")
    parser.add_argument("--timeout", type=int, default=300, help="Timeout per stage, seconds")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    for executable in [args.und, args.upython, args.cmake]:
        if not shutil.which(executable) and not Path(executable).is_file():
            parser.error(f"Executable not found: {executable}")
    output = ROOT / "results" / ("understand-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    output.mkdir(parents=True)
    steps = []
    state = {"status": "running", "steps": steps, "fixtures": {}, "note": "No GUI or built-in AI activation is performed. Script does not configure or collect license values. A completed export is not proof of complete parsing."}

    def save():
        (output / "summary.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def run(name, command):
        command = [str(value) for value in command]
        print(f"[{name}] {subprocess.list2cmdline(command)}", flush=True)
        start = time.monotonic()
        log = output / (name + ".log")
        process_options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        with log.open("w", encoding="utf-8") as stream:
            process = subprocess.Popen(command, cwd=output, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, **process_options)
            try:
                code = process.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=stream, stderr=subprocess.STDOUT, check=False)
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
                steps.append({"stage": name, "status": "timed_out", "seconds": round(time.monotonic() - start, 3), "log": str(log)})
                save()
                raise RuntimeError(f"{name} timed out; inspect {log}")
        steps.append({"stage": name, "exit_code": code, "seconds": round(time.monotonic() - start, 3), "log": str(log), "command": command})
        save()
        if code:
            raise RuntimeError(f"{name} failed with exit {code}; inspect {log}")

    try:
        run("api-version", [args.upython, "-c", "import understand; print(understand.version())"])
        for fixture in ["sample", "sample-explicit"]:
            source = ROOT / fixture
            build = output / (fixture + "-build")
            run(fixture + "-configure", [args.cmake, "-S", source, "-B", build, "-G", args.generator, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "-DCMAKE_BUILD_TYPE=Debug"])
            run(fixture + "-build", [args.cmake, "--build", build, "--config", "Debug", "--parallel", "2"])
            binary = next((file for file in [build / "pipeline", build / "pipeline.exe", build / "Debug/pipeline.exe", build / "Debug/pipeline"] if file.is_file()), None)
            if binary is None:
                raise RuntimeError(f"Built executable missing in {build}")
            run(fixture + "-functional", [binary])
            compdb = build / "compile_commands.json"
            if not compdb.is_file():
                raise RuntimeError("compile_commands.json missing; choose Ninja or Unix Makefiles with an available C++ compiler")
            database = output / (fixture + ".und")
            run(fixture + "-analyze", [args.und, "-db", database, "create", "-languages", "all", "add", compdb, "analyze"])
            exported = output / (fixture + "-export")
            run(fixture + "-export", [args.upython, ROOT / "export_understand.py", database, "--output", exported])
            state["fixtures"][fixture] = json.loads((exported / "summary.json").read_text(encoding="utf-8"))
            save()
        covered = all(fixture["cross_layer_reference_evidence"] and not fixture["errors"] for fixture in state["fixtures"].values())
        state["status"] = "reference_check_passed" if covered else "semantic_gap_detected"
        save()
        print(json.dumps({"status": state["status"], "summary": str(output / "summary.json")}, ensure_ascii=False, indent=2))
        return 0 if covered else 2
    except Exception as error:
        state["status"] = "execution_failed"
        state["error"] = str(error)
        save()
        print(str(error), file=sys.stderr)
        print(f"Logs retained: {output}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
