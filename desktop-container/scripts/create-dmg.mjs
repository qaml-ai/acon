import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function log(message) {
  process.stdout.write(`[create-dmg] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status ?? "null"}`,
    );
  }
}

function parseArgs(argv) {
  let app = null;
  let output = null;
  let volumeName = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];

    if (argument === "--app") {
      app = next ?? null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--app=")) {
      app = argument.slice("--app=".length);
      continue;
    }
    if (argument === "--output") {
      output = next ?? null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
      continue;
    }
    if (argument === "--volume-name") {
      volumeName = next ?? null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--volume-name=")) {
      volumeName = argument.slice("--volume-name=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!app) {
    throw new Error("--app is required");
  }
  if (!output) {
    throw new Error("--output is required");
  }

  return {
    app: resolve(app),
    output: resolve(output),
    volumeName: volumeName?.trim() || basename(app, ".app"),
  };
}

function copyApp(sourceAppPath, destinationAppPath) {
  run("ditto", [sourceAppPath, destinationAppPath]);
}

function main() {
  const { app, output, volumeName } = parseArgs(process.argv.slice(2));
  const tempRoot = mkdtempSync(join(tmpdir(), "super-camel-dmg-"));
  const stageRoot = join(tempRoot, "stage");
  const stageApp = join(stageRoot, basename(app));

  try {
    run("mkdir", ["-p", stageRoot]);
    log(`copying ${app}`);
    copyApp(app, stageApp);
    symlinkSync("/Applications", join(stageRoot, "Applications"));
    rmSync(output, { force: true });
    log(`creating ${output}`);
    run("hdiutil", [
      "create",
      "-ov",
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      "-volname",
      volumeName,
      "-srcfolder",
      stageRoot,
      output,
    ]);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

main();
