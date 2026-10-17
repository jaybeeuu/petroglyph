import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFilePath), "../../..");
const scriptPath = resolve(repoRoot, "packages/infra/scripts/migrate-ssm-namespace.sh");

interface LegacyParameter {
  Name: string;
  Value: string;
  Type: string;
}

interface Snapshot {
  workspace: string;
  parameters: LegacyParameter[];
}

interface MigrationResult {
  snapshot: Snapshot;
  calls: string[][];
}

const AWS_STUB = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("get-caller-identity")) {
  process.stdout.write("123456789012");
} else if (args.includes("put-parameter")) {
  appendFileSync(process.env.PETROGLYPH_TEST_CALLS, JSON.stringify(args) + "\\n");
} else if (args.includes("get-parameters-by-path")) {
  const path = args[args.indexOf("--path") + 1];
  if (path === "/petroglyph") {
    process.stdout.write(process.env.PETROGLYPH_TEST_PARAMETERS ?? "[]");
  } else {
    process.stdout.write("/petroglyph/production/github/client-id");
  }
}
`;

const TERRAFORM_STUB = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "state" && args[1] === "list") {
  const address = args[2];
  if (address === undefined) {
    process.stdout.write(
      [
        "aws_ssm_parameter.github_client_id",
        "aws_ssm_parameter.onedrive_client_secret",
        "aws_ssm_parameter.jwt_private_key",
      ].join("\\n") + "\\n",
    );
  } else if ((process.env.PETROGLYPH_TEST_STATE_ALARMS ?? "").split(",").includes(address)) {
    process.stdout.write(address + "\\n");
  }
} else if (args[0] === "apply") {
  appendFileSync(process.env.PETROGLYPH_TEST_CALLS, JSON.stringify(args) + "\\n");
}
`;

/** Runs the migration script with `aws` and `terraform` replaced by recording stubs. */
function runMigration(parameters: LegacyParameter[], stateAlarms: string[] = []): MigrationResult {
  const workingDirectory = mkdtempSync(join(tmpdir(), "petroglyph-ssm-migration-"));
  const binDirectory = join(workingDirectory, "bin");
  const callsPath = join(workingDirectory, "calls.jsonl");
  const snapshotPath = join(workingDirectory, "snapshot.json");
  mkdirSync(binDirectory);
  writeFileSync(callsPath, "");
  writeFileSync(join(binDirectory, "aws"), AWS_STUB);
  writeFileSync(join(binDirectory, "terraform"), TERRAFORM_STUB);
  chmodSync(join(binDirectory, "aws"), 0o755);
  chmodSync(join(binDirectory, "terraform"), 0o755);

  try {
    execFileSync(
      "bash",
      [
        scriptPath,
        "--profile",
        "test-admin",
        "--workspace",
        "production",
        "--snapshot",
        snapshotPath,
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
          PETROGLYPH_TEST_PARAMETERS: JSON.stringify(parameters),
          PETROGLYPH_TEST_STATE_ALARMS: stateAlarms.join(","),
          PETROGLYPH_TEST_CALLS: callsPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
    return { snapshot, calls };
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

function restoredParameter(call: string[]): { name: string; value: string; type: string } {
  const valueOf = (flag: string): string => call[call.indexOf(flag) + 1] ?? "";
  const inlineValue = call.find((argument) => argument.startsWith("--value="));
  return {
    name: valueOf("--name"),
    value: inlineValue?.slice("--value=".length) ?? "",
    type: valueOf("--type"),
  };
}

describe("migrate-ssm-namespace.sh", () => {
  it("restores every legacy value to its namespaced path without hand re-entry", () => {
    const privateKeyPem = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n";
    const legacy: LegacyParameter[] = [
      { Name: "/petroglyph/github/client-id", Value: "github-client-id", Type: "SecureString" },
      {
        Name: "/petroglyph/onedrive/client-secret",
        Value: "onedrive-client-secret",
        Type: "SecureString",
      },
      { Name: "/petroglyph/jwt/private-key", Value: privateKeyPem, Type: "SecureString" },
      {
        Name: "/petroglyph/production/github/client-id",
        Value: "already-namespaced",
        Type: "SecureString",
      },
    ];

    const { snapshot, calls } = runMigration(legacy);

    expect(snapshot.workspace).toBe("production");
    expect(snapshot.parameters.map((parameter) => parameter.Name)).toEqual([
      "/petroglyph/github/client-id",
      "/petroglyph/onedrive/client-secret",
      "/petroglyph/jwt/private-key",
    ]);
    expect(calls.filter((call) => call.includes("put-parameter")).map(restoredParameter)).toEqual([
      {
        name: "/petroglyph/production/github/client-id",
        value: "github-client-id",
        type: "SecureString",
      },
      {
        name: "/petroglyph/production/onedrive/client-secret",
        value: "onedrive-client-secret",
        type: "SecureString",
      },
      {
        name: "/petroglyph/production/jwt/private-key",
        value: privateKeyPem,
        type: "SecureString",
      },
    ]);
  });

  it("passes a value beginning with a hyphen as a single argument", () => {
    const secret = "-AbC123~xyz_def";
    const { calls } = runMigration([
      { Name: "/petroglyph/onedrive/client-secret", Value: secret, Type: "SecureString" },
    ]);

    const putCall = calls.find((call) => call.includes("put-parameter"));
    expect(putCall).toBeDefined();
    // Passed as `--value <secret>`, the AWS CLI argparser reads the secret as an
    // option and fails with "argument --value: expected one argument".
    expect(putCall).toContain(`--value=${secret}`);
    expect(putCall).not.toContain("--value");
  });

  it("targets the SSM parameters plus any instance whose address moved, and nothing else", () => {
    const movedAlarm = "aws_cloudwatch_metric_alarm.staged_events_dlq_depth";
    const { calls } = runMigration(
      [{ Name: "/petroglyph/github/client-id", Value: "github-client-id", Type: "SecureString" }],
      [movedAlarm],
    );

    const applyCall = calls.find((call) => call[0] === "apply");
    expect(applyCall).toBeDefined();
    expect((applyCall ?? []).filter((argument) => argument.startsWith("-target="))).toEqual([
      "-target=aws_ssm_parameter.github_client_id",
      "-target=aws_ssm_parameter.onedrive_client_secret",
      "-target=aws_ssm_parameter.jwt_private_key",
      `-target=${movedAlarm}`,
    ]);
  });

  it("leaves the DLQ alarms untargeted when they are not at the unindexed address", () => {
    const { calls } = runMigration([
      { Name: "/petroglyph/github/client-id", Value: "github-client-id", Type: "SecureString" },
    ]);

    const applyCall = calls.find((call) => call[0] === "apply");
    expect(
      (applyCall ?? []).filter((argument) =>
        argument.startsWith("-target=aws_cloudwatch_metric_alarm"),
      ),
    ).toEqual([]);
  });
});
