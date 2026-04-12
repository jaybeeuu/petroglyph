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
