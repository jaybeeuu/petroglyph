# ---------------------------------------------------------------------------
# API Gateway HTTP API v2
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "petroglyph_api" {
  name          = "petroglyph-api-${terraform.workspace}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers = ["content-type", "authorization"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_origins = ["*"]
    max_age       = 300
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_apigatewayv2_integration" "petroglyph_api" {
  api_id                 = aws_apigatewayv2_api.petroglyph_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.petroglyph_api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.petroglyph_api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.petroglyph_api.id}"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.petroglyph_api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.petroglyph_api.id}"
}

resource "aws_cloudwatch_log_group" "api_gateway_access_logs" {
  name              = "/aws/apigateway/petroglyph-${terraform.workspace}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.petroglyph_api.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway_access_logs.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      responseLength = "$context.responseLength"
    })
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.petroglyph_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.petroglyph_api.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "lambda_api" {
  name              = "/aws/lambda/${aws_lambda_function.petroglyph_api.function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}
