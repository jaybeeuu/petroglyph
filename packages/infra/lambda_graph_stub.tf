# ---------------------------------------------------------------------------
# QA Graph stub — a Lambda + function URL standing in for Microsoft Graph in
# the qa workspace. The adapter's GRAPH_BASE_URL points here so the deployed
# smoke is deterministic; production never provisions it (empty zip var) and
# keeps the real Graph base URL.
# ---------------------------------------------------------------------------

locals {
  graph_stub_base_url = (
    var.graph_stub_zip_s3_bucket != ""
    ? trimsuffix(aws_lambda_function_url.petroglyph_graph_stub[0].function_url, "/")
    : ""
  )

  # Only qa redirects Graph at the stub. Every other workspace keeps the real
  # endpoint even when a stub artifact is supplied (plan-time applies).
  adapter_graph_uses_stub = terraform.workspace == "qa" && local.graph_stub_base_url != ""
  adapter_graph_base_url = (
    local.adapter_graph_uses_stub
    ? local.graph_stub_base_url
    : var.graph_base_url
  )

  # Lambda Function URLs reject a literal "$" in the query string with a 400,
  # so percent-encode OData system options when the stub is the target. Real
  # Microsoft Graph accepts the literal "$".
  adapter_graph_query_prefix = local.adapter_graph_uses_stub ? "%24" : "$"
}

resource "aws_iam_role" "petroglyph_graph_stub_role" {
  count = var.graph_stub_zip_s3_bucket != "" ? 1 : 0

  name               = "petroglyph-graph-stub-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_graph_stub_policy" {
  count = var.graph_stub_zip_s3_bucket != "" ? 1 : 0

  name = "petroglyph-graph-stub-policy"
  role = aws_iam_role.petroglyph_graph_stub_role[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-graph-stub-${terraform.workspace}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "petroglyph_graph_stub" {
  count = var.graph_stub_zip_s3_bucket != "" ? 1 : 0

  function_name = "petroglyph-graph-stub-${terraform.workspace}"

  s3_bucket = var.graph_stub_zip_s3_bucket
  s3_key    = var.graph_stub_zip_s3_key

  runtime = "nodejs24.x"
  handler = "dist/handler.handler"

  role    = aws_iam_role.petroglyph_graph_stub_role[0].arn
  timeout = 10

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_lambda_function_url" "petroglyph_graph_stub" {
  count = var.graph_stub_zip_s3_bucket != "" ? 1 : 0

  function_name = aws_lambda_function.petroglyph_graph_stub[0].function_name
  # The adapter's Graph client sends a bearer token but cannot SigV4-sign, so
  # the stub URL is public. It serves only canned QA fixtures.
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "lambda_graph_stub" {
  count = var.graph_stub_zip_s3_bucket != "" ? 1 : 0

  name              = "/aws/lambda/${aws_lambda_function.petroglyph_graph_stub[0].function_name}"
  retention_in_days = 14

  tags = {
    environment = terraform.workspace
  }
}
