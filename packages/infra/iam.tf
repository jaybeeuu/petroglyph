data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  lambda_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })

  staged_bucket_arn = aws_s3_bucket.staged_pdfs.arn

  dynamodb_arn_prefix = "arn:aws:dynamodb:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:table"

  ssm_arn_prefix = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter"

  lambda_log_group_arn_prefix = "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda"
}

# ---------------------------------------------------------------------------
# API role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_api_role" {
  name               = "petroglyph-api-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_api_policy" {
  name = "petroglyph-api-policy"
  role = aws_iam_role.petroglyph_api_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBReadWrite"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ]
        Resource = [
          "${local.dynamodb_arn_prefix}/users",
          "${local.dynamodb_arn_prefix}/refresh_tokens",
          "${local.dynamodb_arn_prefix}/sync_profiles",
        ]
      },
      {
        Sid    = "S3Read"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket",
        ]
        Resource = [
          local.staged_bucket_arn,
          "${local.staged_bucket_arn}/*",
        ]
      },
      {
        Sid    = "SSMGetParameter"
        Effect = "Allow"
        Action = "ssm:GetParameter"
        Resource = [
          "${local.ssm_arn_prefix}/petroglyph/github/*",
          "${local.ssm_arn_prefix}/petroglyph/jwt/*",
        ]
      },
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-api-${terraform.workspace}:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Ingest-OneDrive role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_ingest_onedrive_role" {
  name               = "petroglyph-ingest-onedrive-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_ingest_onedrive_policy" {
  name = "petroglyph-ingest-onedrive-policy"
  role = aws_iam_role.petroglyph_ingest_onedrive_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "S3PutObject"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${local.staged_bucket_arn}/*"
      },
      {
        Sid    = "SSMGetParameter"
        Effect = "Allow"
        Action = "ssm:GetParameter"
        Resource = [
          "${local.ssm_arn_prefix}/petroglyph/onedrive/*",
          "${local.ssm_arn_prefix}/petroglyph/graph/*",
        ]
      },
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-ingest-onedrive-${terraform.workspace}:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Processor role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_processor_role" {
  name               = "petroglyph-processor-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_processor_policy" {
  name = "petroglyph-processor-policy"
  role = aws_iam_role.petroglyph_processor_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBReadWrite"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
        ]
        Resource = [
          "${local.dynamodb_arn_prefix}/file_records",
          "${local.dynamodb_arn_prefix}/sync_profiles",
        ]
      },
      {
        Sid    = "S3GetDelete"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = "${local.staged_bucket_arn}/*"
      },
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-processor-${terraform.workspace}:*"
      },
    ]
  })
}
