# ---------------------------------------------------------------------------
# API Lambda function
#
# Handler: dist/health.handler — the current entry point is the health check.
# This will be updated to dist/index.handler once a proper index.ts is added
# to the API package.
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "petroglyph_api" {
  function_name = "petroglyph-api-${terraform.workspace}"

  s3_bucket = var.api_zip_s3_bucket
  s3_key    = var.api_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/health.handler"

  role = aws_iam_role.petroglyph_api_role.arn

  timeout                        = 30
  reserved_concurrent_executions = 10

  environment {
    variables = {
      GITHUB_CLIENT_ID_SSM_PATH     = aws_ssm_parameter.github_client_id.name
      GITHUB_CLIENT_SECRET_SSM_PATH = aws_ssm_parameter.github_client_secret.name
      JWT_SIGNING_SECRET_SSM_PATH   = aws_ssm_parameter.jwt_signing_secret.name
    }
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_function_url" "petroglyph_api" {
  function_name      = aws_lambda_function.petroglyph_api.function_name
  # auth_type will be tightened to AWS_IAM with API Gateway in dv4.7.4
  authorization_type = "NONE"
}

output "api_lambda_arn" {
  description = "ARN of the petroglyph API Lambda function"
  value       = aws_lambda_function.petroglyph_api.arn
}

output "api_function_url" {
  description = "Invoke URL of the petroglyph API Lambda function URL"
  value       = aws_lambda_function_url.petroglyph_api.function_url
}
