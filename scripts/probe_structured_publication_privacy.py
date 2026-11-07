#!/usr/bin/env python3
"""Deliberately fail disposable real journeys; publish only a sanitized receipt.

Requires the existing CI Go/Node dependencies and verified sandboxed Chrome.
Never installs anything. All child logs, reports, images and issued bearers stay
under a private /tmp directory, including the intentionally unsafe control.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
JOURNEY = WEB / "tests/structured-publication-journey.ui.spec.ts"
HELPER = WEB / "tests/structured-publication-backend.ts"
RECEIPT = ROOT / "bin/verification/structured-publication-privacy.json"
MARKER = "STRUCTURED_PUBLICATION_EXPECTED_PRIVACY_FAILURE"
CASES = ("control-assertion", "fixed-assertion", "fixed-timeout")
MAX_BYTES = 128 * 1024 * 1024
CHECKS = frozenset({"contract", "operation", "source-anchor", "report-global-errors", "report-single-spec",
                   "report-single-test", "report-expected-status", "report-outcome", "report-single-result",
                   "report-result-status", "report-retry", "report-single-error", "failure-formatted-identity",
                   "failure-primary-identity", "failure-stack", "report-stat-unexpected", "report-stat-expected",
                   "report-stat-skipped", "report-stat-flaky", "checkpoint-url", "checkpoint-mask",
                   "checkpoint-recovery", "checkpoint-access", "runner-exit", "artifact-scan",
                   "control-aria-leak", "fixed-bearer-leak"})
STEPS = frozenset({"prepare", "runner", "checkpoint-read", "checkpoint-validate", "artifact-scan",
                  "report-read", "case-validation"})


class ProbeContractError(ValueError):
    def __init__(self, check):
        self.check = check if check in CHECKS else "contract"
        super().__init__("privacy probe contract failed")


def require(condition, check="contract"):
    if not condition:
        raise ProbeContractError(check)


def safe_failure_details(details):
    """Only fixed identifiers, strict booleans and bounded counters may escape."""
    safe = {}
    for key, allowed in (("step", STEPS), ("check", CHECKS)):
        if isinstance(details.get(key), str) and details[key] in allowed:
            safe[key] = details[key]
    for key in ("checkpointPresent", "reportPresent", "checkpointMasked", "checkpointRecovered",
                "accessReadCountOK", "accessReadStatusOK", "cleanupCompleted",
                "bearerFound", "automaticAriaBearerFound"):
        if type(details.get(key)) is bool:
            safe[key] = details[key]
    for key, low, high in (("runnerExitCode", -128, 255), ("filesScanned", 0, 1000000),
                           ("embeddedReportEntries", 0, 1000000)):
        if type(details.get(key)) is int and low <= details[key] <= high:
            safe[key] = details[key]
    return safe


def scan_artifacts(root, bearer):
    """Inspect raw files and compressed HTML report payloads, without echoing."""
    result = {"bearerFound": False, "automaticAriaBearerFound": False,
              "filesScanned": 0, "embeddedReportEntries": 0}
    budget = MAX_BYTES

    def inspect(data, name, depth=0):
        nonlocal budget
        budget -= len(data)
        require(budget >= 0 and depth <= 4)
        found = bearer in data or bearer.decode().encode("utf-16-le") in data
        result["bearerFound"] |= found
        if name.endswith("error-context.md"):
            result["automaticAriaBearerFound"] |= found
        archives = []
        if data.startswith(b"PK\x03\x04"):
            archives.append(data)
        for encoded in re.findall(rb"data:application/zip;base64,([A-Za-z0-9+/=]+)", data):
            archives.append(base64.b64decode(encoded, validate=True))
        for archive in archives:
            with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
                for member in zipped.infolist():
                    require(member.file_size <= budget)
                    result["embeddedReportEntries"] += 1
                    inspect(zipped.read(member), member.filename, depth + 1)

    for path in sorted(root.rglob("*")):
        require(not path.is_symlink())
        if path.is_file():
            require(path.stat().st_size <= budget)
            inspect(path.read_bytes(), path.name)
            result["filesScanned"] += 1
    return result


def expected_failure(report, timed_out):
    specs = []

    def walk(suite):
        specs.extend(suite.get("specs", []))
        for child in suite.get("suites", []):
            walk(child)

    for suite in report.get("suites", []):
        walk(suite)
    require(not report.get("errors"), "report-global-errors")
    require(len(specs) == 1, "report-single-spec")
    tests = specs[0].get("tests", [])
    require(len(tests) == 1, "report-single-test")
    test = tests[0]
    require(test.get("expectedStatus") == "passed", "report-expected-status")
    require(test.get("status") == "unexpected", "report-outcome")
    results = test.get("results", [])
    require(len(results) == 1, "report-single-result")
    result = results[0]
    require(result.get("status") == ("timedOut" if timed_out else "failed"), "report-result-status")
    require(result.get("retry") == 0, "report-retry")
    errors = result.get("errors", [])
    require(len(errors) == 1, "report-single-error")
    # JSONReporter formats errors[] as message/location and retains the raw
    # primary error (including its stack) in result.error, not errors[0].
    primary = result.get("error", {})
    for message, check in ((errors[0].get("message", ""), "failure-formatted-identity"),
                           (primary.get("message", ""), "failure-primary-identity")):
        identified = bool(re.search(r"Test timeout of \d+ms exceeded", message)) if timed_out else MARKER in message
        require(identified, check)
    require(bool(primary.get("stack")), "failure-stack")
    stats = report.get("stats", {})
    require(stats.get("unexpected") == 1, "report-stat-unexpected")
    for key in ("expected", "skipped", "flaky"):
        require(stats.get(key) == 0, f"report-stat-{key}")
    return {"expectedErrorIdentified": True, "errorStackPreserved": True,
            "exactlyOneUnretriedFailure": True, "testTimedOut": timed_out}


# Runs only in the disposable copy after the real recovery and explicit masked
# screenshot. Decode that PNG in the existing browser, checking opaque mask
# pixels over visible bearer/QR rectangles; byte searches alone cannot read PNGs.
CHECKPOINT = r'''
      const privacyProbeCheckpoint = process.env.ROUTEWEAVER_PRIVACY_CHECKPOINT;
      if (!privacyProbeCheckpoint) throw new Error("Privacy probe checkpoint unavailable");
      const privacyImage = (await readFile(info.outputPath(frames[frames.length - 1].file))).toString("base64");
      const maskedPixels = await page.evaluate(async (encoded) => {
        try {
          const image = new Image();
          const loaded = new Promise<void>((resolve, reject) => {
            image.onload = () => resolve(); image.onerror = () => reject(new Error());
          });
          image.src = `data:image/png;base64,${encoded}`;
          await loaded;
          if (image.width !== innerWidth || image.height !== innerHeight) return false;
          const canvas = document.createElement("canvas");
          canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext("2d");
          if (!context) return false;
          context.drawImage(image, 0, 0);
          const inputs = document.querySelectorAll('[role="dialog"] input[aria-label="订阅链接"]');
          if (inputs.length !== 1) return false;
          const controls = [...inputs, ...document.querySelectorAll(".qr-container")];
          let checked = 0;
          for (const control of controls) {
            const box = control.getBoundingClientRect();
            const left = Math.max(0, Math.ceil(box.left) + 1), top = Math.max(0, Math.ceil(box.top) + 1);
            const right = Math.min(innerWidth, Math.floor(box.right) - 1), bottom = Math.min(innerHeight, Math.floor(box.bottom) - 1);
            if (right <= left || bottom <= top) continue;
            const pixels = context.getImageData(left, top, right - left, bottom - top).data;
            for (let i = 0; i < pixels.length; i += 4)
              if (pixels[i] !== 255 || pixels[i + 1] !== 0 || pixels[i + 2] !== 255 || pixels[i + 3] !== 255) return false;
            checked++;
          }
          return checked > 0;
        } catch { return false; }
      }, privacyImage);
      const privacyReady = await page.evaluate(accessDeliveryObservation, deliveryCheck);
      // Private comparison material, never attached, logged or copied to artifacts.
      await writeFile(privacyProbeCheckpoint, JSON.stringify({
        url: new URL(f.chosen.feedPath!, baseURL!).href,
        maskedPixels,
        recovered: privacyReady.inputVisible && privacyReady.linkMatches && privacyReady.downloadMatches && privacyReady.downloadReady,
        accessReadAttempts: interceptedAccessReads, interruptedAccessStatus,
      }), { mode: 0o600 });
'''


def replace_once(source, old, new):
    require(source.count(old) == 1, "source-anchor")
    return source.replace(old, new, 1)


def probe_source(source, case):
    require(case in CASES)
    source = replace_once(source, "for (const width of [1440, 390])", "for (const width of [1440])")
    source = replace_once(source, "    test.setTimeout(90000);", "    const privacyProbeStartedAt = Date.now();\n    test.setTimeout(90000);")
    if case == "control-assertion":
        # The only mitigation removed in the positive control is the reviewed
        # public page-fixture override. Production and fixed copies are untouched.
        source = replace_once(source, '''const test = isolatedTest.extend({
  page: async ({ page }, use) => {
    try { await use(page); }
    finally { await page.close(); }
  },
});''', "const test = isolatedTest;")
    fail = ('      test.setTimeout(Date.now() - privacyProbeStartedAt + 1000);\n'
            '      await new Promise<void>(() => {});\n') if case == "fixed-timeout" else (
                f'      expect(false, "{MARKER}").toBe(true);\n')
    anchor = '      await capture("access-recovered", access);'
    return replace_once(source, anchor, anchor + "\n" + CHECKPOINT + fail)


def checkpoint_bearer(checkpoint):
    match = re.fullmatch(r"http://127\.0\.0\.1:\d+/feed/([A-Za-z0-9_-]{43})", checkpoint.get("url", ""))
    require(match is not None, "checkpoint-url")
    require(checkpoint.get("maskedPixels") is True, "checkpoint-mask")
    require(checkpoint.get("recovered") is True, "checkpoint-recovery")
    require(checkpoint.get("accessReadAttempts") == 2 and checkpoint.get("interruptedAccessStatus") == 200, "checkpoint-access")
    # The URL-safe token catches full URLs, paths and JSON/HTML-escaped URLs too.
    return match[1].encode()


def case_receipt(case, report, checkpoint, scan, exit_code):
    require(case in CASES and exit_code == 1, "runner-exit")
    checkpoint_bearer(checkpoint)
    diagnostics = expected_failure(report, case == "fixed-timeout")
    require(scan["filesScanned"] > 0 and scan["embeddedReportEntries"] > 0, "artifact-scan")
    if case == "control-assertion":
        require(scan["bearerFound"] and scan["automaticAriaBearerFound"], "control-aria-leak")
    else:
        require(not scan["bearerFound"], "fixed-bearer-leak")
    return {"case": case, "passed": True, "recoveredAccessVerified": True,
            "maskedPixelsVerified": True, "interruptedAccessStatus": 200,
            "accessReadAttempts": 2, "runnerExitCode": exit_code, **diagnostics, **scan}


def probe_config(filename, raw):
    # Inherit the verified Chrome path and sandbox from the normal public config.
    # Only the isolated CLI fixture starts servers, so the unrelated demo/Vite
    # webServer entries are not started for these disposable probe copies.
    return f'''import {{ defineConfig }} from "@playwright/test";
import base from "./playwright.config";
const chromium = base.projects?.find((project) => project.name === "chromium");
if (!chromium) throw new Error("Chromium project is required for privacy probe");
export default defineConfig({{
  ...base, testDir: "./tests", webServer: undefined,
  // One deliberately failing test must complete without the runner creating a
  // separate max-failure onError. The driver still requires exactly one failed
  // result, zero retries and zero top-level errors; it never accepts a skip.
  workers: 1, retries: 0, repeatEach: 1, maxFailures: 0,
  outputDir: {json.dumps(str(raw / 'results'))},
  projects: [{{ ...chromium, testMatch: {json.dumps(filename)} }}],
  reporter: [
    ["list"],
    ["json", {{ outputFile: {json.dumps(str(raw / 'report.json'))} }}],
    ["html", {{ outputFolder: {json.dumps(str(raw / 'html'))}, open: "never" }}],
  ],
}});
'''


def process_group_running(pgid):
    """Linux CI group liveness; exited zombies cannot keep writing artifacts."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    require(Path("/proc").is_dir())
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rpartition(") ")[2].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if len(fields) >= 3 and int(fields[2]) == pgid and fields[0] not in ("Z", "X"):
            return True
    return False


def drain_process_group(process, grace=20, kill_grace=10):
    # A dead runner can leave its worker/control-plane group alive. Drain the
    # known group regardless of the leader's poll status, without process-name
    # killing. Chrome has a separate Playwright-owned group; its normal worker
    # shutdown remains responsible for it. This is not a universal tree reaper.
    for sig, seconds in ((signal.SIGTERM, grace), (signal.SIGKILL, kill_grace)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + seconds
        while process_group_running(process.pid) and time.monotonic() < deadline:
            process.poll()  # Reap the direct child, independently of its group.
            time.sleep(0.025)
        if not process_group_running(process.pid):
            break
    require(not process_group_running(process.pid))
    process.wait(timeout=kill_grace)


def run_case(case, source, private, details):
    details.update(step="prepare", cleanupCompleted=False)
    case_dir = private / case
    raw = case_dir / "raw"
    raw.mkdir(parents=True, mode=0o700)
    checkpoint = case_dir / "checkpoint.json"  # Deliberately outside the scanned report tree.
    generated = []
    process = None
    try:
        for directory, suffix in ((WEB / "tests", ".privacy-probe.ts"), (WEB, ".privacy-probe.config.ts")):
            fd, filename = tempfile.mkstemp(prefix="structured-publication-", suffix=suffix, dir=directory)
            os.close(fd)
            generated.append(Path(filename))
        test, config = generated
        test.write_text(probe_source(source, case))
        config.write_text(probe_config(test.name, raw))
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("PLAYWRIGHT_HTML_", "PLAYWRIGHT_JSON_"))}
        env["ROUTEWEAVER_PRIVACY_CHECKPOINT"] = str(checkpoint)
        details["step"] = "runner"
        with (raw / "runner.log").open("wb") as output:
            process = subprocess.Popen(
                ["node", str(WEB / "node_modules/playwright/cli.js"), "test", "--config", str(config)],
                cwd=WEB, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            code = process.wait(timeout=300)
        details.update(runnerExitCode=code, checkpointPresent=checkpoint.is_file(),
                       reportPresent=(raw / "report.json").is_file())
        # No subprocess output is printed, even for an early or unexpected failure.
        details["step"] = "checkpoint-read"
        state = json.loads(checkpoint.read_text())
        details.update(step="checkpoint-validate", checkpointMasked=state.get("maskedPixels") is True,
                       checkpointRecovered=state.get("recovered") is True,
                       accessReadCountOK=state.get("accessReadAttempts") == 2,
                       accessReadStatusOK=state.get("interruptedAccessStatus") == 200)
        bearer = checkpoint_bearer(state)
        details["step"] = "artifact-scan"
        scan = scan_artifacts(raw, bearer)
        details.update(scan)
        details["step"] = "report-read"
        report = json.loads((raw / "report.json").read_text())
        details["step"] = "case-validation"
        return case_receipt(case, report, state, scan, code)
    finally:
        try:
            if process is not None:
                drain_process_group(process)
        finally:
            for path in generated:
                path.unlink(missing_ok=True)
        details["cleanupCompleted"] = True


def main():
    receipt = {"passed": False, "cases": [], "runnerAttempted": False,
               "rawArtifactsPublished": False, "privateFilesRemoved": False}
    stage = "preflight"
    details = {}
    private_path = None
    try:
        # Refuse an inherited snapshot suppression flag: the positive control
        # must exercise default automatic ARIA capture, not an internal override.
        require(not os.environ.get("PLAYWRIGHT_NO_COPY_PROMPT"))
        chrome = Path(os.environ.get("ROUTEWEAVER_CHROMIUM", ""))
        require(chrome.is_file() and os.access(chrome, os.X_OK))
        require((WEB / "node_modules/playwright/cli.js").is_file())
        source = JOURNEY.read_text()
        before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (JOURNEY, HELPER)}
        receipt["sourceSHA256"] = before
        receipt["playwrightVersion"] = json.loads((WEB / "node_modules/playwright/package.json").read_text())["version"]
        # Explicit /tmp, not TMPDIR or a repository-relative directory that an
        # existing upload glob could accidentally pick up, even on failure.
        with tempfile.TemporaryDirectory(prefix="routeweaver-privacy-probe-", dir="/tmp") as directory:
            private_path = Path(directory)
            require(not private_path.resolve().is_relative_to(ROOT.resolve()))
            require(private_path.stat().st_mode & 0o777 == 0o700)
            for case in CASES:
                stage = case
                details = {}
                receipt["runnerAttempted"] = True
                receipt["cases"].append(run_case(case, source, private_path, details))
            stage = "source-unchanged"
            require(before == {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (JOURNEY, HELPER)})
        receipt["passed"] = True
    except (Exception, KeyboardInterrupt) as error:
        # Deliberately omit exception strings/tracebacks and all child output.
        # They may contain the comparison bearer or a reporter preview.
        receipt["failedStage"] = stage
        details["check"] = error.check if isinstance(error, ProbeContractError) else "operation"
        receipt["failureDetails"] = safe_failure_details(details)
    finally:
        receipt["privateFilesRemoved"] = private_path is None or not private_path.exists()
        receipt["passed"] = receipt["passed"] and receipt["privateFilesRemoved"]
        RECEIPT.parent.mkdir(parents=True, exist_ok=True)
        RECEIPT.write_text(json.dumps(receipt, indent=2) + "\n")
    print("PASS: structured publication failure-artifact privacy probe." if receipt["passed"] else
          "FAIL: structured publication privacy probe; sanitized receipt only, no raw diagnostics published.")
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
