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

  aws_region              = "eu-west-2"
  file_records_table_name = "petroglyph-file-records-${terraform.workspace}"
  file_records_table_arn  = "arn:aws:dynamodb:${local.aws_region}:*:table/${local.file_records_table_name}"

  ssm_arn_prefix = "arn:aws:ssm:${local.aws_region}:*:parameter"

  lambda_log_group_arn_prefix = "arn:aws:logs:${local.aws_region}:*:log-group:/aws/lambda"
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
          aws_dynamodb_table.users.arn,
          aws_dynamodb_table.refresh_tokens.arn,
          aws_dynamodb_table.sync_profiles.arn,
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
        Sid      = "SQSSendMessage"
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.ingest.arn
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
        Sid    = "DynamoDBWriteFileRecords"
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]
        Resource = local.file_records_table_arn
      },
      {
        Sid      = "S3PutObject"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${local.staged_bucket_arn}/*"
      },
      {
        Sid    = "SSMReadWriteOnedriveTokens"
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:PutParameter",
        ]
        Resource = "${local.ssm_arn_prefix}/petroglyph/onedrive/*"
      },
      {
        Sid    = "SQSReadIngestQueue"
        Effect = "Allow"
        Action = [
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ReceiveMessage",
        ]
        Resource = aws_sqs_queue.ingest.arn
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
