import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// Runs a deploy job's `run:` steps from `.github/workflows/deploy.yml` against
// stub `terraform`, `aws` and `pnpm` binaries, so tests can assert what the
// workflow does rather than what its text says. The workflow file stays the
// single source: every edit to a step script is executed here on the next run,
// so the coverage cannot drift from the thing it covers.
//
// `uses:` steps (checkout, caches, artifact download, credential setup) are
// GitHub-owned actions with no local seam; they are skipped. Everything they
// would provide is simulated instead: the reference zips are written into the
// workspace up front, and secrets are supplied through the scenario.

const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows/deploy.yml",
);

export interface DeployWorkflowStep {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
  readonly if?: string;
  readonly env?: Readonly<{ [key: string]: string }>;
  readonly "working-directory"?: string;
}

export interface DeployWorkflowJob {
  readonly environment?: string;
  readonly env?: Readonly<{ [key: string]: string }>;
  readonly steps?: readonly DeployWorkflowStep[];
}

export interface DeployWorkflow {
  readonly jobs: Readonly<{ [key: string]: DeployWorkflowJob }>;
}

export interface StubCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: {
    readonly TF_WORKSPACE: string | null;
    readonly LAMBDA_FUNCTION_URL: string | null;
  };
}

export interface DeployJobScenario {
  /** Job name in `deploy.yml`, e.g. `deploy-qa`. */
  readonly job: string;
  /** Value rendered into `${{ github.sha }}`. */
  readonly githubSha?: string;
  /** Secret values, merged over the documented defaults. */
  readonly secrets?: Readonly<{ [key: string]: string }>;
  /** Terraform workspaces the stubbed backend already holds. Defaults to the job's own workspace. */
  readonly existingWorkspaces?: readonly string[];
  /** S3 object keys that already exist in the artifact bucket. */
  readonly existingObjects?: readonly string[];
  /** Terraform outputs. Any output the workflow reads that is not listed resolves to a stub URL. */
  readonly outputs?: Readonly<{ [key: string]: string }>;
}

export interface DeployJobRun {
  /** Stub invocations in execution order. */
  readonly calls: readonly StubCall[];
}

const DEFAULT_SECRETS: Readonly<{ [key: string]: string }> = {
  AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/petroglyph-github-actions-deploy-test",
  LAMBDA_ARTIFACT_BUCKET: "petroglyph-lambda-artifacts-123456789012",
  TF_STATE_BUCKET: "petroglyph-terraform-state-123456789012",
};

/** Every artifact the workflow packages is a zip of this shape; the tests hash these bytes. */
const ARTIFACT_PATH_PATTERN = /packages\/[\w-]+\/lambda\.zip/g;

const recordCall = (command: string): string => `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(
  process.env.PETROGLYPH_TEST_CALLS,
  JSON.stringify({
    command: ${JSON.stringify(command)},
    args,
    environment: {
      TF_WORKSPACE: process.env.TF_WORKSPACE ?? null,
      LAMBDA_FUNCTION_URL: process.env.LAMBDA_FUNCTION_URL ?? null,
    },
  }) + "\\n",
);
const fail = (message) => {
  process.stderr.write(message + "\\n");
  process.exit(1);
};
`;

// The stub reproduces the terraform contract that broke CD in #185: while
// TF_WORKSPACE is set, every `terraform workspace` subcommand refuses to run,
// and `workspace new` fails if the workspace exists while `workspace select`
// fails if it does not.
const TERRAFORM_STUB = `#!/usr/bin/env node
${recordCall("terraform")}
const existingWorkspaces = (process.env.PETROGLYPH_TEST_WORKSPACES ?? "").split(",").filter(Boolean);
const outputs = JSON.parse(process.env.PETROGLYPH_TEST_OUTPUTS ?? "{}");
const [command, subcommand, value] = args;

if (command === "workspace") {
  if (args.length !== 3) {
    fail("unsupported workspace invocation: " + args.join(" "));
  }
  if (process.env.TF_WORKSPACE) {
    fail("The selected workspace is currently overridden using the TF_WORKSPACE environment variable.");
  }
  if (subcommand === "select" && !existingWorkspaces.includes(value)) {
    fail('Workspace "' + value + '" doesn\\'t exist.');
  }
  if (subcommand === "new" && existingWorkspaces.includes(value)) {
    fail('Workspace "' + value + '" already exists.');
  }
  if (subcommand !== "select" && subcommand !== "new") {
    fail("unsupported workspace subcommand: " + subcommand);
  }
  process.exit(0);
}

if (command === "output" && args.length === 3 && subcommand === "-raw") {
  const output = outputs[value];
  if (output === undefined) {
    fail('Output "' + value + '" not found.');
  }
  process.stdout.write(output + "\\n");
  process.exit(0);
}

if (command === "init" || command === "apply") {
  process.exit(0);
}

fail("unsupported terraform command: " + args.join(" "));
`;

const AWS_STUB = `#!/usr/bin/env node
${recordCall("aws")}
const existingObjects = JSON.parse(process.env.PETROGLYPH_TEST_EXISTING_OBJECTS ?? "[]");

if (args[0] === "s3api" && args[1] === "head-object") {
  const key = args[args.indexOf("--key") + 1];
  if (existingObjects.includes(key)) {
    process.stdout.write("{}\\n");
    process.exit(0);
  }
  fail("An error occurred (404) when calling the HeadObject operation: Not Found");
}

if (args[0] === "s3" && args[1] === "cp") {
  process.exit(0);
}

fail("unsupported aws command: " + args.join(" "));
`;

const PNPM_STUB = `#!/usr/bin/env node
${recordCall("pnpm")}
process.exit(0);
`;

/** The bytes the `package` job would have produced for a given zip path. */
export function createArtifactBytes(zipPath: string): Buffer {
  return Buffer.from(`lambda zip for ${zipPath}\n`);
}

export function readDeployWorkflow(): DeployWorkflow {
  return parseYaml(readFileSync(workflowPath, "utf8")) as DeployWorkflow;
}

/** Runs one deploy job's `run:` steps, in order, with stubbed external commands. */
export function runDeployJob(scenario: DeployJobScenario): DeployJobRun {
  const job = readDeployWorkflow().jobs[scenario.job];
  if (job === undefined) {
    throw new Error(`deploy.yml has no job "${scenario.job}"`);
  }

  const root = mkdtempSync(join(tmpdir(), `petroglyph-${scenario.job}-`));
  const binDirectory = join(root, "bin");
  const scriptDirectory = join(root, "scripts");
  const outputDirectory = join(root, "step-outputs");
  const runnerTemp = join(root, "runner-temp");
  const workspace = join(root, "workspace");
  const callsPath = join(root, "calls.jsonl");
  const steps = job.steps ?? [];

  mkdirSync(binDirectory);
  mkdirSync(scriptDirectory);
  mkdirSync(outputDirectory);
  mkdirSync(runnerTemp);
  writeStub(binDirectory, "terraform", TERRAFORM_STUB);
  writeStub(binDirectory, "aws", AWS_STUB);
  writeStub(binDirectory, "pnpm", PNPM_STUB);
  writeFileSync(callsPath, "");

  // The `package` job uploads these zips as artifacts; the deploy job downloads
  // them before any step that references one runs.
  for (const zipPath of referencedArtifactPaths(steps)) {
    const absolutePath = join(workspace, zipPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, createArtifactBytes(zipPath));
  }

  const secrets = { ...DEFAULT_SECRETS, ...scenario.secrets };
  const stepOutputs: { [key: string]: { [key: string]: string } } = {};
  const expressionContext = {
    secrets,
    github: { sha: scenario.githubSha ?? "0".repeat(40), ref: "refs/heads/main" },
    stepOutputs,
  };
  const jobEnvironment = renderRecord(job.env ?? {}, expressionContext);
  const workspaceName = jobEnvironment["TF_WORKSPACE"] ?? "";
  const existingWorkspaces = scenario.existingWorkspaces ?? [workspaceName];
  const outputs = {
    ...Object.fromEntries(
      referencedOutputNames(steps).map((name) => [name, `https://stub.invalid/${name}`]),
    ),
    ...scenario.outputs,
  };

  try {
    for (const [index, step] of steps.entries()) {
      if (step.run === undefined) {
        continue;
      }
      const environment = {
        ...jobEnvironment,
        ...renderRecord(step.env ?? {}, expressionContext),
      };
      if (step.if !== undefined && !isConditionMet(step.if, environment)) {
        continue;
      }

      const GITHUB_OUTPUT = join(outputDirectory, `${index}.txt`);
      writeFileSync(GITHUB_OUTPUT, "");
      // GitHub evaluates `${{ }}` in the step body before the shell sees it.
      const scriptPath = join(scriptDirectory, `${index}.sh`);
      writeFileSync(scriptPath, renderExpressions(step.run, expressionContext));
      const workingDirectory = join(workspace, step["working-directory"] ?? ".");
      mkdirSync(workingDirectory, { recursive: true });

      try {
        execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptPath], {
          cwd: workingDirectory,
          env: {
            PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
            GITHUB_OUTPUT,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: runnerTemp,
            PETROGLYPH_TEST_CALLS: callsPath,
            PETROGLYPH_TEST_EXISTING_OBJECTS: JSON.stringify(scenario.existingObjects ?? []),
            PETROGLYPH_TEST_OUTPUTS: JSON.stringify(outputs),
            PETROGLYPH_TEST_WORKSPACES: existingWorkspaces.join(","),
            ...environment,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error: unknown) {
        throw new Error(
          `job "${scenario.job}" step "${step.name ?? index}" failed:\n${stderrOf(error)}`,
          { cause: error },
        );
      }

      if (step.id !== undefined) {
        stepOutputs[step.id] = readStepOutputs(GITHUB_OUTPUT);
      }
    }

    return { calls: readCalls(callsPath) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface ExpressionContext {
  readonly secrets: Readonly<{ [key: string]: string }>;
  readonly github: Readonly<{ [key: string]: string }>;
  readonly stepOutputs: Readonly<{ [key: string]: Readonly<{ [key: string]: string }> }>;
}

function referencedArtifactPaths(steps: readonly DeployWorkflowStep[]): string[] {
  const paths = new Set<string>();
  for (const step of steps) {
    for (const match of (step.run ?? "").matchAll(ARTIFACT_PATH_PATTERN)) {
      paths.add(match[0]);
    }
  }
  return [...paths];
}

/** Terraform outputs the job reads, so the stub answers every one it asks for. */
function referencedOutputNames(steps: readonly DeployWorkflowStep[]): string[] {
  const names = new Set<string>();
  for (const step of steps) {
    for (const match of (step.run ?? "").matchAll(/terraform output -raw (?<name>[\w-]+)/g)) {
      if (match.groups?.["name"] !== undefined) {
        names.add(match.groups["name"]);
      }
    }
  }
  return [...names];
}

function writeStub(binDirectory: string, name: string, source: string): void {
  const path = join(binDirectory, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function renderRecord(
  values: Readonly<{ [key: string]: string }>,
  context: ExpressionContext,
): { [key: string]: string } {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, renderExpressions(value, context)]),
  );
}

function renderExpressions(value: string, context: ExpressionContext): string {
  return value.replace(/\$\{\{\s*(?<expression>[^{}]+?)\s*\}\}/g, (_match, expression: string) =>
    resolveExpression(expression, context),
  );
}

// GitHub renders an unresolvable expression as the empty string; an expression
// form this harness does not model throws instead, so a new construct fails the
// suite rather than silently running with a value it never evaluated.
function resolveExpression(expression: string, context: ExpressionContext): string {
  const [scope, ...rest] = expression.split(".");
  if (scope === "secrets" && rest.length === 1) {
    return context.secrets[rest[0] ?? ""] ?? "";
  }
  if (scope === "github" && rest.length === 1) {
    return context.github[rest[0] ?? ""] ?? "";
  }
  if (scope === "steps" && rest.length === 3 && rest[1] === "outputs") {
    return context.stepOutputs[rest[0] ?? ""]?.[rest[2] ?? ""] ?? "";
  }
  throw new Error(`unsupported workflow expression: \${{ ${expression} }}`);
}

function isConditionMet(
  condition: string,
  environment: Readonly<{ [key: string]: string }>,
): boolean {
  const match = /^env\.(?<name>[\w-]+) (?<operator>!=|==) '(?<literal>.*)'$/.exec(condition.trim());
  if (match?.groups === undefined) {
    throw new Error(`unsupported step condition: ${condition}`);
  }
  const value = environment[match.groups["name"] ?? ""] ?? "";
  return match.groups["operator"] === "!="
    ? value !== match.groups["literal"]
    : value === match.groups["literal"];
}

function readStepOutputs(path: string): { [key: string]: string } {
  const outputs: { [key: string]: string } = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      throw new Error(`unrecognised GITHUB_OUTPUT line: ${line}`);
    }
    outputs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return outputs;
}

function readCalls(path: string): StubCall[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as StubCall);
}

function stderrOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const { stderr } = error as { stderr?: unknown };
    if (Buffer.isBuffer(stderr)) {
      return stderr.toString();
    }
  }
  return error instanceof Error ? error.message : "";
}
