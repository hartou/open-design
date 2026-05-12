import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DESKTOP_UPDATE_CHANNELS,
  DESKTOP_UPDATE_STATES,
  SIDECAR_SOURCES,
} from "@open-design/sidecar-proto";

import { compareVersions, createDesktopUpdater, DESKTOP_UPDATE_ENV, resolveDesktopUpdaterConfig } from "../../src/main/updater.js";

type FixtureServer = {
  close: () => Promise<void>;
  metadataUrl: string;
};

async function createUpdaterFixture(options: {
  artifactBody?: string;
  channel?: "stable" | "beta";
  version?: string;
} = {}): Promise<FixtureServer> {
  const version = options.version ?? "1.0.1";
  const channel = options.channel ?? "stable";
  const artifactBody = options.artifactBody ?? "open design updater fixture";
  const digest = createHash("sha256").update(artifactBody).digest("hex");
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/metadata.json") {
      response.setHeader("content-type", "application/json");
      const betaMatch = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/.exec(version);
      response.end(JSON.stringify({
        channel,
        ...(channel === "beta"
          ? {
              baseVersion: betaMatch?.[1],
              betaNumber: betaMatch?.[2] == null ? undefined : Number(betaMatch[2]),
              betaVersion: version,
            }
          : {
              baseVersion: version,
              releaseVersion: version,
              stableVersion: version,
            }),
        platforms: {
          mac: {
            arch: "arm64",
            enabled: true,
            artifacts: {
              dmg: {
                name: `open-design-${version}-mac-arm64.dmg`,
                sha256Url: `http://${serverAddress(server)}/artifact.dmg.sha256`,
                size: Buffer.byteLength(artifactBody),
                url: `http://${serverAddress(server)}/artifact.dmg`,
              },
            },
          },
        },
        version: 1,
      }));
      return;
    }
    if (url === "/artifact.dmg") {
      response.setHeader("content-length", String(Buffer.byteLength(artifactBody)));
      response.end(artifactBody);
      return;
    }
    if (url === "/artifact.dmg.sha256") {
      response.end(`${digest}  artifact.dmg\n`);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = serverAddress(server);
  return {
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error == null ? resolveClose() : rejectClose(error)));
      });
    },
    metadataUrl: `http://${address}/metadata.json`,
  };
}

function serverAddress(server: Server): string {
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("fixture server is not listening on TCP");
  return `127.0.0.1:${address.port}`;
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "od-updater-test-"));
}

function updaterEnv(metadataUrl: string): NodeJS.ProcessEnv {
  return {
    [DESKTOP_UPDATE_ENV.AUTO_DOWNLOAD]: "1",
    [DESKTOP_UPDATE_ENV.CURRENT_VERSION]: "1.0.0",
    [DESKTOP_UPDATE_ENV.ENABLED]: "1",
    [DESKTOP_UPDATE_ENV.METADATA_URL]: metadataUrl,
    [DESKTOP_UPDATE_ENV.OPEN_DRY_RUN]: "1",
    [DESKTOP_UPDATE_ENV.PLATFORM]: "darwin",
  };
}

describe("desktop updater", () => {
  it("downloads, verifies, persists, and dry-runs opening a mac package", async () => {
    const root = makeRoot();
    const fixture = await createUpdaterFixture();
    try {
      const updater = createDesktopUpdater({
        arch: "arm64",
        downloadRoot: root,
        env: updaterEnv(fixture.metadataUrl),
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.DOWNLOADED);
      expect(checked.channel).toBe(DESKTOP_UPDATE_CHANNELS.STABLE);
      expect(checked.availableVersion).toBe("1.0.1");
      expect(checked.checksum?.algorithm).toBe("sha256");
      expect(checked.downloadPath).toEqual(expect.any(String));
      expect(relative(await realpath(root), checked.downloadPath ?? "")).not.toMatch(/^\.\./);
      expect(await readFile(checked.downloadPath ?? "", "utf8")).toBe("open design updater fixture");

      const restored = await updater.status();
      expect(restored.state).toBe(DESKTOP_UPDATE_STATES.DOWNLOADED);
      expect(restored.downloadPath).toBe(checked.downloadPath);

      const installed = await updater.installUpdate();
      expect(installed.state).toBe(DESKTOP_UPDATE_STATES.DOWNLOADED);
      expect(installed.installResult?.dryRun).toBe(true);
      expect(installed.installResult?.path).toBe(checked.downloadPath);
    } finally {
      await fixture.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports not-available when metadata is not newer than the current app", async () => {
    const root = makeRoot();
    const fixture = await createUpdaterFixture({ version: "1.0.0" });
    try {
      const updater = createDesktopUpdater({
        arch: "arm64",
        downloadRoot: root,
        env: updaterEnv(fixture.metadataUrl),
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.NOT_AVAILABLE);
      expect(checked.downloadPath).toBeUndefined();
    } finally {
      await fixture.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts beta metadata that exposes betaVersion instead of releaseVersion", async () => {
    const root = makeRoot();
    const fixture = await createUpdaterFixture({ channel: "beta", version: "1.0.1-beta.2" });
    try {
      const updater = createDesktopUpdater({
        arch: "arm64",
        downloadRoot: root,
        env: {
          ...updaterEnv(fixture.metadataUrl),
          [DESKTOP_UPDATE_ENV.CURRENT_VERSION]: "1.0.1-beta.1",
        },
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.DOWNLOADED);
      expect(checked.channel).toBe(DESKTOP_UPDATE_CHANNELS.BETA);
      expect(checked.availableVersion).toBe("1.0.1-beta.2");
    } finally {
      await fixture.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("re-verifies a downloaded package before opening it", async () => {
    const root = makeRoot();
    const fixture = await createUpdaterFixture();
    try {
      const updater = createDesktopUpdater({
        arch: "arm64",
        downloadRoot: root,
        env: updaterEnv(fixture.metadataUrl),
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.DOWNLOADED);
      await writeFile(checked.downloadPath ?? "", "tampered", "utf8");

      const installed = await updater.installUpdate();
      expect(installed.state).toBe(DESKTOP_UPDATE_STATES.ERROR);
      expect(installed.error?.code).toBe("checksum-mismatch");
      expect(installed.installResult).toBeUndefined();
    } finally {
      await fixture.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("defaults beta builds to the beta update channel", () => {
    const root = makeRoot();
    try {
      const config = resolveDesktopUpdaterConfig({
        currentVersion: "1.2.3-beta.4",
        downloadRoot: root,
        env: {
          [DESKTOP_UPDATE_ENV.ENABLED]: "1",
        },
        source: SIDECAR_SOURCES.PACKAGED,
      });

      expect(config.channel).toBe(DESKTOP_UPDATE_CHANNELS.BETA);
      expect(config.metadataUrl).toContain("/beta/latest/metadata.json");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not offer an arm64-only mac package to x64 clients", async () => {
    const root = makeRoot();
    const fixture = await createUpdaterFixture();
    try {
      const updater = createDesktopUpdater({
        arch: "x64",
        downloadRoot: root,
        env: updaterEnv(fixture.metadataUrl),
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.ERROR);
      expect(checked.error?.code).toBe("no-compatible-artifact");
      expect(checked.error?.message).toContain("macIntel");
    } finally {
      await fixture.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("refuses aggressive cleanup in a non-owned update root", async () => {
    const root = makeRoot();
    const fixture = await createUpdaterFixture();
    const alienFile = join(root, "do-not-delete.txt");
    try {
      await writeFile(alienFile, "user file", "utf8");
      const updater = createDesktopUpdater({
        arch: "arm64",
        downloadRoot: root,
        env: updaterEnv(fixture.metadataUrl),
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.ERROR);
      expect(checked.error?.code).toBe("update-root-not-owned");
      expect(existsSync(alienFile)).toBe(true);
    } finally {
      await fixture.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  const symlinkIt = process.platform === "win32" ? it.skip : it;
  symlinkIt("refuses to use a symlinked updater root", async () => {
    const realRoot = makeRoot();
    const linkParent = makeRoot();
    const linkRoot = join(linkParent, "updates");
    const fixture = await createUpdaterFixture();
    try {
      symlinkSync(realRoot, linkRoot, "dir");
      const updater = createDesktopUpdater({
        arch: "arm64",
        downloadRoot: linkRoot,
        env: updaterEnv(fixture.metadataUrl),
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.ERROR);
      expect(checked.error?.code).toBe("update-root-not-owned");
      expect(existsSync(join(realRoot, ".open-design-updater-root.json"))).toBe(false);
    } finally {
      await fixture.close();
      rmSync(linkParent, { force: true, recursive: true });
      rmSync(realRoot, { force: true, recursive: true });
    }
  });

  symlinkIt("refuses to use symlinked updater subdirectories", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const fixture = await createUpdaterFixture();
    const outsideMarker = join(outside, "outside.txt");
    try {
      await writeFile(outsideMarker, "outside", "utf8");
      const updater = createDesktopUpdater({
        arch: "arm64",
        downloadRoot: root,
        env: updaterEnv(fixture.metadataUrl),
        source: SIDECAR_SOURCES.TOOLS_PACK,
      });
      await updater.status();
      symlinkSync(outside, join(root, "artifacts"), "dir");

      const checked = await updater.checkForUpdates();
      expect(checked.state).toBe(DESKTOP_UPDATE_STATES.ERROR);
      expect(checked.error?.code).toBe("download-failed");
      expect(existsSync(outsideMarker)).toBe(true);
    } finally {
      await fixture.close();
      rmSync(root, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it("compares stable and prerelease versions", () => {
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-beta.9")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });
});
