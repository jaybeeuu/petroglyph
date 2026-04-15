# ---------------------------------------------------------------------------
# SQS ingestion queue and DLQ
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "ingest_dlq" {
  name = "petroglyph-ingest-dlq-${terraform.workspace}"

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_sqs_queue" "ingest" {
  name                       = "petroglyph-ingest-${terraform.workspace}"
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 180

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_cloudwatch_metric_alarm" "ingest_dlq_depth" {
  alarm_name          = "petroglyph-ingest-dlq-depth-${terraform.workspace}"
  alarm_description   = "Alerts when the OneDrive ingest processor sends messages to the DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.ingest_dlq.name
  }
}

# ---------------------------------------------------------------------------
# Webhook receiver Lambda function
# Microsoft Graph expects webhook POST acknowledgements to return HTTP 200 quickly.
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_ingest_onedrive" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-ingest-onedrive-${terraform.workspace}"

  s3_bucket = var.ingest_onedrive_zip_s3_bucket
  s3_key    = var.ingest_onedrive_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/index.handler"

  role    = aws_iam_role.petroglyph_ingest_onedrive_role.arn
  timeout = 10

  environment {
    variables = {
      INGEST_QUEUE_URL = aws_sqs_queue.ingest.url
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_apigatewayv2_integration" "petroglyph_ingest_onedrive" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  api_id                 = aws_apigatewayv2_api.petroglyph_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.petroglyph_ingest_onedrive[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "onedrive_webhook_post" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  api_id    = aws_apigatewayv2_api.petroglyph_api.id
  route_key = "POST /webhooks/onedrive"
  target    = "integrations/${aws_apigatewayv2_integration.petroglyph_ingest_onedrive[0].id}"
}

resource "aws_lambda_permission" "api_gateway_ingest_onedrive" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  statement_id  = "AllowAPIGatewayInvokeIngestOnedrive"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.petroglyph_ingest_onedrive[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.petroglyph_api.execution_arn}/*/*/webhooks/onedrive"
}

resource "aws_cloudwatch_log_group" "lambda_ingest_onedrive" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_ingest_onedrive[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}

# ---------------------------------------------------------------------------
# Processor Lambda function
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_processor" {
  count = var.processor_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-processor-${terraform.workspace}"

  s3_bucket = var.processor_zip_s3_bucket
  s3_key    = var.processor_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/index.handler"

  role    = aws_iam_role.petroglyph_processor_role.arn
  timeout = 60

  environment {
    variables = {
      FILE_RECORDS_TABLE  = local.file_records_table_name
      MICROSOFT_CLIENT_ID = aws_ssm_parameter.onedrive_client_id.value
      STAGED_PDFS_BUCKET  = aws_s3_bucket.staged_pdfs.bucket
      STAGED_PDF_PREFIX   = "handwritten"
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_event_source_mapping" "processor_ingest_queue" {
  count = var.processor_zip_s3_bucket != "" ? 1 : 0

  event_source_arn        = aws_sqs_queue.ingest.arn
  function_name           = aws_lambda_function.petroglyph_processor[0].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_log_group" "lambda_processor" {
  count = var.processor_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_processor[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}
