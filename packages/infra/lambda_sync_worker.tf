# ---------------------------------------------------------------------------
# SQS sync-job queue and DLQ
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "sync_jobs_dlq" {
  name = "petroglyph-sync-jobs-dlq-${terraform.workspace}"

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_sqs_queue" "sync_jobs" {
  name                       = "petroglyph-sync-jobs-${terraform.workspace}"
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sync_jobs_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_cloudwatch_metric_alarm" "sync_jobs_dlq_depth" {
  alarm_name          = "petroglyph-sync-jobs-dlq-depth-${terraform.workspace}"
  alarm_description   = "Alerts when the sync-worker sends messages to the DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.sync_jobs_dlq.name
  }
}

# ---------------------------------------------------------------------------
# Sync-worker Lambda function
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_sync_worker" {
  count = var.sync_worker_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-sync-worker-${terraform.workspace}"

  s3_bucket = var.sync_worker_zip_s3_bucket
  s3_key    = var.sync_worker_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/index.handler"

  role    = aws_iam_role.petroglyph_sync_worker_role.arn
  timeout = 300

  environment {
    variables = {
      FILE_RECORDS_TABLE   = local.file_records_table_name
      DELTA_TOKENS_TABLE   = local.delta_tokens_table_name
      SYNC_JOBS_TABLE      = aws_dynamodb_table.sync_jobs.name
      REFRESH_TOKENS_TABLE = aws_dynamodb_table.refresh_tokens.name
      INGEST_QUEUE_URL     = aws_sqs_queue.ingest.url
      MICROSOFT_CLIENT_ID  = aws_ssm_parameter.onedrive_client_id.value
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_event_source_mapping" "sync_worker_queue" {
  count = var.sync_worker_zip_s3_bucket != "" ? 1 : 0

  event_source_arn        = aws_sqs_queue.sync_jobs.arn
  function_name           = aws_lambda_function.petroglyph_sync_worker[0].arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_log_group" "lambda_sync_worker" {
  count = var.sync_worker_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_sync_worker[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}
