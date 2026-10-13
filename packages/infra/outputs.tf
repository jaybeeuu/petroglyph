output "api_endpoint" {
  description = "Invoke URL of the API Gateway HTTP API"
  value       = aws_apigatewayv2_api.petroglyph_api.api_endpoint
}

output "onedrive_webhook_url" {
  description = "Webhook receiver URL for Microsoft Graph change notifications"
  value       = "${aws_apigatewayv2_api.petroglyph_api.api_endpoint}/webhooks/onedrive"
}

output "ingest_queue_url" {
  description = "URL of the SQS ingestion queue"
  value       = aws_sqs_queue.ingest.url
}

output "ingest_queue_arn" {
  description = "ARN of the SQS ingestion queue"
  value       = aws_sqs_queue.ingest.arn
}

output "ingest_dlq_name" {
  description = "Name of the SQS dead-letter queue for ingestion failures"
  value       = aws_sqs_queue.ingest_dlq.name
}

output "ingest_dlq_url" {
  description = "URL of the SQS dead-letter queue for ingestion failures"
  value       = aws_sqs_queue.ingest_dlq.url
}

output "ingest_dlq_arn" {
  description = "ARN of the SQS dead-letter queue for ingestion failures"
  value       = aws_sqs_queue.ingest_dlq.arn
}

output "sync_jobs_stream_arn" {
  description = "ARN of the DynamoDB stream on the sync-jobs table"
  value       = aws_dynamodb_table.sync_jobs.stream_arn
}

output "staged_events_queue_url" {
  description = "URL of the staging internal FIFO queue (forwarder → dispatch)"
  value       = aws_sqs_queue.staged_events.url
}

output "staged_events_queue_arn" {
  description = "ARN of the staging internal FIFO queue"
  value       = aws_sqs_queue.staged_events.arn
}

output "delta_trigger_queue_url" {
  description = "URL of the delta-trigger FIFO queue (bell → adapter)"
  value       = aws_sqs_queue.delta_trigger.url
}

output "delta_trigger_queue_arn" {
  description = "ARN of the delta-trigger FIFO queue"
  value       = aws_sqs_queue.delta_trigger.arn
}

output "event_log_stream_arn" {
  description = "ARN of the DynamoDB stream on the event-log table"
  value       = aws_dynamodb_table.event_log.stream_arn
}

output "files_feed_url" {
  description = "The /files delivery surface URL"
  value       = "${aws_apigatewayv2_api.petroglyph_api.api_endpoint}/files"
}

output "graph_stub_function_url" {
  description = "Invoke URL of the QA Graph stub Lambda function URL (empty when the stub is not deployed)"
  value       = local.graph_stub_base_url
}

output "staged_records_table_name" {
  description = "Name of the staged-records index table the smoke polls"
  value       = aws_dynamodb_table.staged_records.name
}

output "sync_profiles_table_name" {
  description = "Name of the sync-profiles table the smoke seeds"
  value       = aws_dynamodb_table.sync_profiles.name
}

output "token_vaults_table_name" {
  description = "Name of the connection token-vault table the smoke seeds"
  value       = aws_dynamodb_table.token_vaults.name
}

output "delta_states_table_name" {
  description = "Name of the delta-state table the smoke resets before triggering"
  value       = aws_dynamodb_table.delta_states.name
}
