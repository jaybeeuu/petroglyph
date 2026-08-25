# ---------------------------------------------------------------------------
# Sync-outbox relay Lambda
# Pushes new sync-job rows (INSERT stream records, status=queued) into the
# sync-jobs SQS queue. The sync-jobs table is the single source of truth for
# dispatch: the API only writes the row, and this relay fans it out.
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_sync_relay" {
  count = var.sync_relay_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-sync-relay-${terraform.workspace}"

  s3_bucket = var.sync_relay_zip_s3_bucket
  s3_key    = var.sync_relay_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/index.handler"

  role    = aws_iam_role.petroglyph_sync_relay_role.arn
  timeout = 30

  environment {
    variables = {
      SYNC_JOB_QUEUE_URL = aws_sqs_queue.sync_jobs.url
      SYNC_JOBS_TABLE    = aws_dynamodb_table.sync_jobs.name
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_event_source_mapping" "sync_jobs_stream" {
  count = var.sync_relay_zip_s3_bucket != "" ? 1 : 0

  event_source_arn        = aws_dynamodb_table.sync_jobs.stream_arn
  function_name           = aws_lambda_function.petroglyph_sync_relay[0].arn
  batch_size              = 10
  starting_position       = "LATEST"
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_log_group" "lambda_sync_relay" {
  count = var.sync_relay_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_sync_relay[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}