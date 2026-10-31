import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ownNativeBrowserProcess } from "./native-browser-process";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  rm: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

it("keeps the owned profile until process exit AND shared stdio close, without termination after graceful close", async () => {
  const child = new ChildProcess();
  const kill = vi.spyOn(child, "kill").mockReturnValue(true);
  const close = ownNativeBrowserProcess(child, "/owned-profile");
  const requestClose = vi.fn(async () => {});
  const done = close(requestClose);
  child.emit("exit", 0, null);
  await Promise.resolve();
  await Promise.resolve();
  expect(rm).not.toHaveBeenCalled();
  child.emit("close", 0, null);
  await expect(done).resolves.toEqual({ code: 0, signal: null });
  expect(requestClose).toHaveBeenCalledOnce();
  expect(kill).not.toHaveBeenCalled();
  expect(rm).toHaveBeenCalledExactlyOnceWith("/owned-profile", {
    recursive: true,
    force: true,
  });
});

it("cleans only the owned process after protocol failure and still reports that failure", async () => {
  const child = new ChildProcess();
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const failure = new Error("CDP disconnected before close request");
  const close = ownNativeBrowserProcess(child, "/owned-profile");
  await expect(
    close(async () => {
      throw failure;
    }),
  ).rejects.toMatchObject({ errors: [failure] });
  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(rm).toHaveBeenCalledExactlyOnceWith("/owned-profile", {
    recursive: true,
    force: true,
  });
});

it("waits for a real synthetic child to flush its profile before removing it", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockImplementation(fs.rm);
  const root = await mkdtemp(join(tmpdir(), "routeweaver-process-test-"));
  const profile = await mkdtemp(join(root, "profile-"));
  const receipt = join(root, "closed.txt");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    process.stdin.once("data", () => {
      fs.writeFileSync(${JSON.stringify(join(profile, "final-flush"))}, "flushed");
      fs.writeFileSync(${JSON.stringify(receipt)}, "gracefully closed");
      process.exit(0);
    });
    process.stdout.write("ready");
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const close = ownNativeBrowserProcess(child, profile);
  try {
    await once(child.stdout, "data");
    await expect(
      close(async () => {
        child.stdin.write("close");
      }),
    ).resolves.toEqual({ code: 0, signal: null });
    expect(await readFile(receipt, "utf8")).toBe("gracefully closed");
    await expect(fs.stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "close");
    }
    await fs.rm(root, { recursive: true, force: true });
    vi.mocked(rm).mockReset();
  }
});

it("retains protocol and filesystem failures instead of hiding the first behind cleanup", async () => {
  const child = new ChildProcess();
  vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  });
  const protocol = new Error("protocol close failed");
  const filesystem = new Error("profile removal failed");
  vi.mocked(rm).mockRejectedValueOnce(filesystem);
  const close = ownNativeBrowserProcess(child, "/owned-profile");
  await expect(
    close(async () => {
      throw protocol;
    }),
  ).rejects.toMatchObject({
    errors: [protocol, filesystem],
  });
});

it("can finish owned startup cleanup when close occurs without an exit event", async () => {
  const child = new ChildProcess();
  const kill = vi.spyOn(child, "kill").mockImplementation(() => {
    queueMicrotask(() => child.emit("close", -2, null));
    return false;
  });
  const close = ownNativeBrowserProcess(child, "/owned-profile");
  await expect(close()).resolves.toEqual({ code: -2, signal: null });
  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(rm).toHaveBeenCalledExactlyOnceWith("/owned-profile", {
    recursive: true,
    force: true,
  });
});

it.each([
  { code: 17, signal: null },
  { code: null, signal: "SIGSEGV" },
] as const)(
  "rejects an owned browser that exited abnormally before teardown ($code, $signal) while removing its profile",
  async ({ code, signal }) => {
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const close = ownNativeBrowserProcess(child, "/owned-profile");
    // The last product assertion can finish before a subsequent browser crash.
    Object.defineProperties(child, {
      exitCode: { value: code },
      signalCode: { value: signal },
    });
    child.emit("close", code, signal);
    const requestClose = vi.fn(async () => {});
    await expect(close(requestClose)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: `Owned browser exited abnormally (code=${code}, signal=${signal})`,
        }),
      ],
    });
    expect(requestClose).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledExactlyOnceWith("/owned-profile", {
      recursive: true,
      force: true,
    });
  },
);
