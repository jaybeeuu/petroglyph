output "api_endpoint" {
  description = "Invoke URL of the API Gateway HTTP API"
  value       = aws_apigatewayv2_api.petroglyph_api.api_endpoint
}
