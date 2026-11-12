import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createArtifactBytes,
  readDeployWorkflow,
  runDeployJob,
  type DeployJobRun,
  type StubCall,
} from "./deploy-workflow-runner.js";

// These tests run the deploy job's own `run:` scripts against stub binaries,
// so they assert what the workflow does rather than what its text says. The
// file this replaces asserted that particular lines existed; one of those lines
// pinned a `terraform workspace select` that had already broken CD for every
// environment (#185). A test here fails when the behaviour changes, not when
// the wording does.
//
// Each test executes every `run:` step of a whole job, and each step spawns a
// stub `terraform`, `aws` or `pnpm` process per invocation. That is dozens of
// process starts per test, so they take seconds even on an idle machine and
// far longer when other work is running beside them. Each test carries an
// explicit budget rather than relying on Vitest's 5 s default (see
// docs/testing.md). The budget is sized to the measured worst case: 1-5 s per
// test normally, and 27 s for one test while the whole monorepo suite ran on a
// heavily contended machine, so 120 s keeps roughly 4x headroom on a slower
// shared CI runner without hiding a genuine hang.
const TIMEOUT_MS = 120_000;

const ARTIFACT_BUCKET = "petroglyph-lambda-artifacts-123456789012";
const API_FUNCTION_URL = "https://abc123defg.lambda-url.eu-west-2.on.aws/";
const COMMIT_SHA = "4f3c2b1a9e8d7c6b5a4039e8271d6c5b4a392817";

interface LambdaArtifact {
  readonly name: string;
  readonly zipPath: string;
  readonly keyPrefix: string;
  readonly applyVariable: string;
}

// Each package the deploy job ships: the zip the `package` job produced, the
// key prefix its artifact is stored under, and the Terraform variable that
// receives that key.
const LAMBDA_ARTIFACTS: readonly LambdaArtifact[] = [
  {
    name: "api",
    zipPath: "packages/api/lambda.zip",
    keyPrefix: "lambda",
    applyVariable: "api_zip_s3_key",
  },
  {
    name: "ingest-onedrive",
    zipPath: "packages/ingest-onedrive/lambda.zip",
    keyPrefix: "ingest-onedrive",
    applyVariable: "ingest_onedrive_zip_s3_key",
  },
  {
    name: "sync-worker",
    zipPath: "packages/sync-worker/lambda.zip",
    keyPrefix: "sync-worker",
    applyVariable: "sync_worker_zip_s3_key",
  },
  {
    name: "sync-relay",
    zipPath: "packages/sync-relay/lambda.zip",
    keyPrefix: "sync-relay",
    applyVariable: "sync_relay_zip_s3_key",
  },
  {
    name: "processor",
    zipPath: "packages/processor/lambda.zip",
    keyPrefix: "processor",
    applyVariable: "processor_zip_s3_key",
  },
  {
    name: "forwarder",
    zipPath: "packages/staging-consumer/lambda.zip",
    keyPrefix: "forwarder",
    applyVariable: "forwarder_zip_s3_key",
  },
  {
    name: "staging-delivery",
    zipPath: "packages/staging-delivery/lambda.zip",
    keyPrefix: "staging-delivery",
    applyVariable: "staging_delivery_zip_s3_key",
  },
];

/** The artifact key the workflow must derive from the zip's bytes. */
function artifactKey(artifact: LambdaArtifact): string {
  const digest = createHash("sha256").update(createArtifactBytes(artifact.zipPath)).digest("hex");
  return `${artifact.keyPrefix}-${digest}.zip`;
}

function stubCalls(run: DeployJobRun, command: string): StubCall[] {
  return run.calls.filter((call) => call.command === command);
}

function isS3Copy(call: StubCall): boolean {
  return call.command === "aws" && call.args[0] === "s3" && call.args[1] === "cp";
}

function isS3HeadObject(call: StubCall): boolean {
  return call.command === "aws" && call.args[0] === "s3api" && call.args[1] === "head-object";
}

function isWorkspaceCommand(call: StubCall, subcommand: "select" | "new"): boolean {
  return (
    call.command === "terraform" && call.args[0] === "workspace" && call.args[1] === subcommand
  );
}

function isTerraformApply(call: StubCall): boolean {
  return call.command === "terraform" && call.args[0] === "apply";
}

function required(call: StubCall | undefined, description: string): StubCall {
  if (call === undefined) {
    throw new Error(`expected the deploy job to ${description}`);
  }
  return call;
}

/** The `-var=name=value` arguments the apply step passed to terraform. */
function terraformVariables(run: DeployJobRun): Map<string, string> {
  const apply = required(stubCalls(run, "terraform").find(isTerraformApply), "run terraform apply");
  const variables = new Map<string, string>();
  for (const argument of apply.args) {
    const assignment = argument.startsWith("-var=") ? argument.slice("-var=".length) : undefined;
    if (assignment === undefined) {
      continue;
    }
    const separator = assignment.indexOf("=");
    variables.set(assignment.slice(0, separator), assignment.slice(separator + 1));
  }
  return variables;
}

function headObjectKey(call: StubCall): string {
  return call.args[call.args.indexOf("--key") + 1] ?? "";
}

function selectedWorkspace(job: string): string {
  const select = required(
    stubCalls(runDeployJob({ job }), "terraform").find((call) =>
      isWorkspaceCommand(call, "select"),
    ),
    `select a Terraform workspace in ${job}`,
  );
  return select.args[2] ?? "";
}

describe("deploy workflow artifact uploads", () => {
  it(
    "uploads each lambda zip under a key derived from the zip's content hash",
    () => {
      const run = runDeployJob({
        job: "deploy-qa",
        githubSha: COMMIT_SHA,
        secrets: { LAMBDA_ARTIFACT_BUCKET: ARTIFACT_BUCKET },
      });
      const uploads = stubCalls(run, "aws").filter(isS3Copy);

      for (const artifact of LAMBDA_ARTIFACTS) {
        const upload = uploads.find((call) => call.args[2] === artifact.zipPath);
        expect(upload?.args[3], artifact.name).toBe(
          `s3://${ARTIFACT_BUCKET}/${artifactKey(artifact)}`,
        );
      }

      const commitShaArguments = run.calls
        .flatMap((call) => call.args)
        .filter((argument) => argument.includes(COMMIT_SHA));
      expect(commitShaArguments).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "skips the upload when an object already exists under the artifact key",
    () => {
      const run = runDeployJob({
        job: "deploy-qa",
        secrets: { LAMBDA_ARTIFACT_BUCKET: ARTIFACT_BUCKET },
        existingObjects: LAMBDA_ARTIFACTS.map(artifactKey),
      });
      const aws = stubCalls(run, "aws");
      const probedKeys = aws.filter(isS3HeadObject).map(headObjectKey);
      const uploadedObjects = aws.filter(isS3Copy).map((call) => call.args[3]);

      for (const artifact of LAMBDA_ARTIFACTS) {
        expect(probedKeys, artifact.name).toContain(artifactKey(artifact));
        expect(uploadedObjects, artifact.name).not.toContain(
          `s3://${ARTIFACT_BUCKET}/${artifactKey(artifact)}`,
        );
      }
    },
    TIMEOUT_MS,
  );

  it(
    "passes the content-hash artifact keys to terraform apply",
    () => {
      const variables = terraformVariables(runDeployJob({ job: "deploy-qa" }));

      for (const artifact of LAMBDA_ARTIFACTS) {
        expect(variables.get(artifact.applyVariable), artifact.name).toBe(artifactKey(artifact));
      }
    },
    TIMEOUT_MS,
  );
});

describe("deploy workflow deployed smoke", () => {
  it(
    "runs the smoke after the apply with the API function URL terraform recorded",
    () => {
      const run = runDeployJob({
        job: "deploy-qa",
        outputs: { api_function_url: API_FUNCTION_URL },
      });
      const applyIndex = run.calls.findIndex(isTerraformApply);
      const smokeIndex = run.calls.findIndex((call) => call.command === "pnpm");
      const smoke = required(run.calls[smokeIndex], "run the deployed smoke");

      expect(applyIndex).toBeGreaterThanOrEqual(0);
      expect(smokeIndex).toBeGreaterThan(applyIndex);
      expect(smoke.args).toEqual(["--filter", "@petroglyph/api", "smoke-test"]);
      expect(smoke.environment.LAMBDA_FUNCTION_URL).toBe(API_FUNCTION_URL);
    },
    TIMEOUT_MS,
  );
});

describe("deploy workflow environments", () => {
  it(
    "binds each deploy job to the GitHub environment matching the workspace it deploys",
    () => {
      const workflow = readDeployWorkflow();
      const workspaceByJob = new Map(
        ["deploy-qa", "deploy-production"].map((job) => [job, selectedWorkspace(job)]),
      );

      for (const [job, workspace] of workspaceByJob) {
        expect(workspace, job).not.toBe("");
        expect(workflow.jobs[job]?.environment, job).toBe(workspace);
      }
      expect(workspaceByJob.get("deploy-qa")).not.toBe(workspaceByJob.get("deploy-production"));
    },
    TIMEOUT_MS,
  );

  it(
    "deploys production to its custom domain and qa to the raw execute-api URL",
    () => {
      const production = terraformVariables(runDeployJob({ job: "deploy-production" }));
      const qa = terraformVariables(runDeployJob({ job: "deploy-qa" }));

      expect(production.get("api_custom_domain")).toBe("api.petroglyph.page");
      expect(qa.get("api_custom_domain")).toBe("");
    },
    TIMEOUT_MS,
  );
});

describe("deploy workflow terraform workspace", () => {
  it(
    "selects an existing workspace with TF_WORKSPACE unset for that step only",
    () => {
      const run = runDeployJob({ job: "deploy-qa", existingWorkspaces: ["qa"] });
      const terraform = stubCalls(run, "terraform");
      const select = required(
        terraform.find((call) => isWorkspaceCommand(call, "select")),
        "select the workspace",
      );
      const apply = required(
        terraform.find(isTerraformApply),
        "apply after selecting the workspace",
      );

      // Terraform refuses `workspace select` while TF_WORKSPACE is set, so the
      // step has to clear it; the apply below still needs the workspace.
      expect(select.args).toEqual(["workspace", "select", "qa"]);
      expect(select.environment.TF_WORKSPACE).toBeNull();
      expect(terraform.filter((call) => isWorkspaceCommand(call, "new"))).toEqual([]);
      expect(terraform.indexOf(select)).toBeLessThan(terraform.indexOf(apply));
      expect(apply.environment.TF_WORKSPACE).toBe("qa");
    },
    TIMEOUT_MS,
  );

  it(
    "creates the workspace when terraform does not have it yet",
    () => {
      const run = runDeployJob({ job: "deploy-qa", existingWorkspaces: [] });
      const terraform = stubCalls(run, "terraform");
      const workspaceCommands = terraform
        .filter((call) => call.args[0] === "workspace")
        .map((call) => call.args.join(" "));

      expect(workspaceCommands).toEqual(["workspace select qa", "workspace new qa"]);
      expect(terraform.some(isTerraformApply)).toBe(true);
    },
    TIMEOUT_MS,
  );
});
