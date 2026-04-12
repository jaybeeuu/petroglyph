import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const infraDirectory = resolve(dirname(currentFilePath), "..");
const terraformScratchDirectory = resolve(infraDirectory, ".vitest-terraform");
let hasValidatedTerraform = false;

function terraformEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_DEFAULT_REGION: "eu-west-2",
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

function runTerraformValidate(): void {
  if (hasValidatedTerraform) {
    return;
  }

  if (existsSync(terraformScratchDirectory)) {
    rmSync(terraformScratchDirectory, { force: true, recursive: true });
  }

  mkdirSync(terraformScratchDirectory, { recursive: true });

  for (const entry of readdirSync(infraDirectory)) {
    if (entry === ".terraform" || entry === ".vitest-terraform" || entry === "backend.tf") {
      continue;
    }

    cpSync(resolve(infraDirectory, entry), resolve(terraformScratchDirectory, entry), {
      recursive: true,
    });
  }

  execFileSync("terraform", ["init", "-backend=false", "-input=false", "-reconfigure"], {
    cwd: terraformScratchDirectory,
    encoding: "utf8",
    env: terraformEnvironment(),
  });
  execFileSync("terraform", ["validate"], {
    cwd: terraformScratchDirectory,
    encoding: "utf8",
    env: terraformEnvironment(),
  });
  hasValidatedTerraform = true;
  rmSync(terraformScratchDirectory, { force: true, recursive: true });
}

function readInfraFile(fileName: string): string {
  return readFileSync(resolve(infraDirectory, fileName), "utf8");
}

describe.sequential("terraform ingestion infrastructure", () => {
  it("declares the ingest queue, DLQ alarm, and queue outputs", () => {
    runTerraformValidate();

    const lambdaIngestionTerraform = readInfraFile("lambda_ingestion.tf");
    const outputsTerraform = readInfraFile("outputs.tf");

    expect(lambdaIngestionTerraform).toMatch(
      /resource "aws_sqs_queue" "ingest" \{[\s\S]*message_retention_seconds\s*=\s*86400[\s\S]*visibility_timeout_seconds\s*=\s*180[\s\S]*redrive_policy = jsonencode\(\{[\s\S]*deadLetterTargetArn = aws_sqs_queue\.ingest_dlq\.arn[\s\S]*maxReceiveCount\s*=\s*3[\s\S]*\}\)/,
    );
    expect(lambdaIngestionTerraform).toMatch(
      /resource "aws_cloudwatch_metric_alarm" "ingest_dlq_depth" \{[\s\S]*evaluation_periods\s*=\s*1[\s\S]*metric_name\s*=\s*"ApproximateNumberOfMessagesVisible"[\s\S]*namespace\s*=\s*"AWS\/SQS"[\s\S]*threshold\s*=\s*0/,
    );
    expect(outputsTerraform).toContain('output "ingest_queue_url"');
    expect(outputsTerraform).toContain('output "ingest_queue_arn"');
    expect(outputsTerraform).toContain('output "ingest_dlq_url"');
    expect(outputsTerraform).toContain('output "ingest_dlq_arn"');
  }, 60_000);

  it("connects the processor lambda to the ingest queue and exposes the webhook route", () => {
    runTerraformValidate();

    const lambdaIngestionTerraform = readInfraFile("lambda_ingestion.tf");
    const outputsTerraform = readInfraFile("outputs.tf");

    expect(lambdaIngestionTerraform).toMatch(
      /resource "aws_lambda_function" "petroglyph_processor" \{[\s\S]*timeout\s*=\s*60[\s\S]*environment \{[\s\S]*MICROSOFT_CLIENT_ID\s*=\s*aws_ssm_parameter\.onedrive_client_id\.value[\s\S]*\}[\s\S]*\}/,
    );
    expect(lambdaIngestionTerraform).toMatch(
      /resource "aws_lambda_event_source_mapping" "processor_ingest_queue" \{[\s\S]*event_source_arn\s*=\s*aws_sqs_queue\.ingest\.arn[\s\S]*function_name\s*=\s*aws_lambda_function\.petroglyph_processor\.arn[\s\S]*batch_size\s*=\s*10/,
    );
    expect(lambdaIngestionTerraform).toContain('route_key = "POST /webhooks/onedrive"');
    expect(lambdaIngestionTerraform).toContain(
      'source_arn    = "${aws_apigatewayv2_api.petroglyph_api.execution_arn}/*/*/webhooks/onedrive"',
    );
    expect(outputsTerraform).toContain(
      'value       = "${aws_apigatewayv2_api.petroglyph_api.api_endpoint}/webhooks/onedrive"',
    );
  });

  it("grants only the required SQS permissions to the webhook receiver and processor", () => {
    runTerraformValidate();

    const iamTerraform = readInfraFile("iam.tf");

    expect(iamTerraform).toMatch(
      /Sid\s*=\s*"SQSSendMessage"[\s\S]*Action\s*=\s*"sqs:SendMessage"[\s\S]*Resource = aws_sqs_queue\.ingest\.arn/,
    );
    expect(iamTerraform).toMatch(
      /Sid\s*=\s*"SQSReadIngestQueue"[\s\S]*Action = \[[\s\S]*"sqs:DeleteMessage"[\s\S]*"sqs:GetQueueAttributes"[\s\S]*"sqs:ReceiveMessage"[\s\S]*\][\s\S]*Resource = aws_sqs_queue\.ingest\.arn/,
    );
  });
});
