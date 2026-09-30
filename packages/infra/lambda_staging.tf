# ---------------------------------------------------------------------------
# Staging internal FIFO queue (forwarder → dispatch) and DLQ
# The forwarder (6.5.2.2) pushes validated business events here; the dispatch
# seam (6.5.2.3) consumers it later. FIFO + MessageGroupId = profileId keeps
# one profile's events ordered; a poison message lands on the DLQ.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "staged_events_dlq" {
  name       = "petroglyph-staged-events-dlq-${terraform.workspace}.fifo"
  fifo_queue = true

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_sqs_queue" "staged_events" {
  name                       = "petroglyph-staged-events-${terraform.workspace}.fifo"
  fifo_queue                 = true
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.staged_events_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_cloudwatch_metric_alarm" "staged_events_dlq_depth" {
  alarm_name          = "petroglyph-staged-events-dlq-depth-${terraform.workspace}"
  alarm_description   = "Alerts when staging dispatch messages land on the DLQ."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.staged_events_dlq.name
  }
}

# ---------------------------------------------------------------------------
# Delta-trigger FIFO queue (bell → adapter) and DLQ
# Webhook bells and Sync-Now requests enqueue per-connection triggers here;
# FIFO MessageGroupId = connection key collapses racing bells and the adapter
# walks exactly once. The adapter lambda consumes it.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "delta_trigger_dlq" {
  name       = "petroglyph-delta-trigger-dlq-${terraform.workspace}.fifo"
  fifo_queue = true

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_sqs_queue" "delta_trigger" {
  name                       = "petroglyph-delta-trigger-${terraform.workspace}.fifo"
  fifo_queue                 = true
  message_retention_seconds  = 86400
  visibility_timeout_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.delta_trigger_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_cloudwatch_metric_alarm" "delta_trigger_dlq_depth" {
  alarm_name          = "petroglyph-delta-trigger-dlq-depth-${terraform.workspace}"
  alarm_description   = "Alerts when delta-trigger bells land on the DLQ (adapter failures)."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.delta_trigger_dlq.name
  }
}

# ---------------------------------------------------------------------------
# Staging forwarder Lambda (6.5.2.2): event-log DDB Streams → staged-events
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_staging_forwarder" {
  count = var.forwarder_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-staging-forwarder-${terraform.workspace}"

  s3_bucket = var.forwarder_zip_s3_bucket
  s3_key    = var.forwarder_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/lambda.handler"

  role    = aws_iam_role.petroglyph_staging_forwarder_role.arn
  timeout = 30

  environment {
    variables = {
      STAGED_EVENTS_QUEUE_URL = aws_sqs_queue.staged_events.url
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_event_source_mapping" "staging_forwarder_event_log_stream" {
  count = var.forwarder_zip_s3_bucket != "" ? 1 : 0

  event_source_arn        = aws_dynamodb_table.event_log.stream_arn
  function_name           = aws_lambda_function.petroglyph_staging_forwarder[0].arn
  batch_size              = 100
  starting_position       = "LATEST"
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_log_group" "lambda_staging_forwarder" {
  count = var.forwarder_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_staging_forwarder[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}

# ---------------------------------------------------------------------------
# OneDrive adapter Lambda (6.5.1.1 flow): delta-trigger FIFO → walk → land →
# emit to the event log. Same deployment artifact as the webhook receiver
# (ingest-onedrive zip) but with the dist/lambda.handler entry point.
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_adapter_onedrive" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-adapter-onedrive-${terraform.workspace}"

  s3_bucket = var.ingest_onedrive_zip_s3_bucket
  s3_key    = var.ingest_onedrive_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/lambda.handler"

  role    = aws_iam_role.petroglyph_adapter_onedrive_role.arn
  timeout = 300

  environment {
    variables = {
      EVENT_LOG_TABLE              = aws_dynamodb_table.event_log.name
      DELTA_TOKENS_TABLE           = aws_dynamodb_table.delta_states.name
      REFRESH_TOKENS_TABLE         = aws_dynamodb_table.token_vaults.name
      SYNC_PROFILES_TABLE          = aws_dynamodb_table.sync_profiles.name
      STAGED_PDFS_BUCKET           = aws_s3_bucket.staged_pdfs.id
      ONEDRIVE_CLIENT_ID_SSM_PATH     = aws_ssm_parameter.onedrive_client_id.name
      ONEDRIVE_CLIENT_SECRET_SSM_PATH = aws_ssm_parameter.onedrive_client_secret.name
      GRAPH_BASE_URL               = "https://graph.microsoft.com/v1.0"
      GRAPH_DRIVE_ROOT_DELTA_URL   = "https://graph.microsoft.com/v1.0/me/drive/root/delta?$select=id,name,parentReference,file,folder,deleted"
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_event_source_mapping" "adapter_delta_trigger_queue" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  event_source_arn        = aws_sqs_queue.delta_trigger.arn
  function_name           = aws_lambda_function.petroglyph_adapter_onedrive[0].arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_cloudwatch_log_group" "lambda_adapter_onedrive" {
  count = var.ingest_onedrive_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_adapter_onedrive[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}

# ---------------------------------------------------------------------------
# Staging delivery Lambda (6.5.2.4): the /files surface — feed + download
# over the staged index + S3, auth-scoped by JWT userId.
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_staging_delivery" {
  count = var.staging_delivery_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-staging-delivery-${terraform.workspace}"

  s3_bucket = var.staging_delivery_zip_s3_bucket
  s3_key    = var.staging_delivery_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/index.handler"

  role    = aws_iam_role.petroglyph_staging_delivery_role.arn
  timeout = 30

  environment {
    variables = {
      FILE_RECORDS_TABLE    = aws_dynamodb_table.staged_records.name
      SYNC_PROFILES_TABLE   = aws_dynamodb_table.sync_profiles.name
      STAGED_PDFS_BUCKET    = aws_s3_bucket.staged_pdfs.id
      JWT_PUBLIC_KEY_SSM_PATH = aws_ssm_parameter.jwt_public_key.name
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_apigatewayv2_integration" "petroglyph_staging_delivery" {
  count = var.staging_delivery_zip_s3_bucket != "" ? 1 : 0

  api_id                 = aws_apigatewayv2_api.petroglyph_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.petroglyph_staging_delivery[0].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "files_get" {
  count = var.staging_delivery_zip_s3_bucket != "" ? 1 : 0

  api_id    = aws_apigatewayv2_api.petroglyph_api.id
  route_key = "GET /files"
  target    = "integrations/${aws_apigatewayv2_integration.petroglyph_staging_delivery[0].id}"
}

resource "aws_apigatewayv2_route" "files_item_get" {
  count = var.staging_delivery_zip_s3_bucket != "" ? 1 : 0

  api_id    = aws_apigatewayv2_api.petroglyph_api.id
  route_key = "GET /files/{itemId}"
  target    = "integrations/${aws_apigatewayv2_integration.petroglyph_staging_delivery[0].id}"
}

resource "aws_lambda_permission" "api_gateway_staging_delivery_feed" {
  count = var.staging_delivery_zip_s3_bucket != "" ? 1 : 0

  statement_id  = "AllowAPIGatewayInvokeStagingDeliveryFeed"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.petroglyph_staging_delivery[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.petroglyph_api.execution_arn}/*/*/files"
}

resource "aws_lambda_permission" "api_gateway_staging_delivery_item" {
  count = var.staging_delivery_zip_s3_bucket != "" ? 1 : 0

  statement_id  = "AllowAPIGatewayInvokeStagingDeliveryItem"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.petroglyph_staging_delivery[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.petroglyph_api.execution_arn}/*/*/files/*"
}

resource "aws_cloudwatch_log_group" "lambda_staging_delivery" {
  count = var.staging_delivery_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_staging_delivery[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}