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
  delta_tokens_table_name = "petroglyph-delta-tokens-${terraform.workspace}"
  delta_tokens_table_arn  = "arn:aws:dynamodb:${local.aws_region}:*:table/${local.delta_tokens_table_name}"

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
          aws_dynamodb_table.file_records.arn,
          aws_dynamodb_table.delta_tokens.arn,
          aws_dynamodb_table.sync_jobs.arn,
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
        Sid    = "SQSSendMessages"
        Effect = "Allow"
        Action = "sqs:SendMessage"
        Resource = [
          aws_sqs_queue.ingest.arn,
        ]
      },
      {
        Sid    = "SSMGetParameter"
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          "${local.ssm_arn_prefix}/petroglyph/github/*",
          "${local.ssm_arn_prefix}/petroglyph/jwt/*",
          "${local.ssm_arn_prefix}/petroglyph/onedrive/*",
          "${local.ssm_arn_prefix}/petroglyph/config/*",
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
        Sid    = "DynamoDBFileRecordsAndTokens"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]
        Resource = [
          local.file_records_table_arn,
          aws_dynamodb_table.refresh_tokens.arn,
        ]
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

# ---------------------------------------------------------------------------
# Sync-outbox relay role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_sync_relay_role" {
  name               = "petroglyph-sync-relay-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_sync_relay_policy" {
  name = "petroglyph-sync-relay-policy"
  role = aws_iam_role.petroglyph_sync_relay_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBReadStream"
        Effect = "Allow"
        Action = [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
        ]
        Resource = [
          aws_dynamodb_table.sync_jobs.arn,
          "${aws_dynamodb_table.sync_jobs.arn}/stream/*",
        ]
      },
      {
        # The relay re-creates queued jobs removed by TTL (retry-on-removal).
        Sid    = "DynamoDBRecreateSyncJobs"
        Effect = "Allow"
        Action = "dynamodb:PutItem"
        Resource = [
          aws_dynamodb_table.sync_jobs.arn,
        ]
      },
      {
        Sid      = "SQSSendMessage"
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.sync_jobs.arn
      },
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-sync-relay-${terraform.workspace}:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Sync-worker role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_sync_worker_role" {
  name               = "petroglyph-sync-worker-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_sync_worker_policy" {
  name = "petroglyph-sync-worker-policy"
  role = aws_iam_role.petroglyph_sync_worker_role.id

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
          local.file_records_table_arn,
          aws_dynamodb_table.delta_tokens.arn,
          aws_dynamodb_table.sync_jobs.arn,
          aws_dynamodb_table.refresh_tokens.arn,
        ]
      },
      {
        Sid    = "SQSReadSyncJobsQueue"
        Effect = "Allow"
        Action = [
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ReceiveMessage",
        ]
        Resource = aws_sqs_queue.sync_jobs.arn
      },
      {
        Sid      = "SQSSendIngestMessage"
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.ingest.arn
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
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-sync-worker-${terraform.workspace}:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Staging forwarder role (6.5.2.2): event-log stream read → staged-events send
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_staging_forwarder_role" {
  name               = "petroglyph-staging-forwarder-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_staging_forwarder_policy" {
  name = "petroglyph-staging-forwarder-policy"
  role = aws_iam_role.petroglyph_staging_forwarder_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBReadEventLogStream"
        Effect = "Allow"
        Action = [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
        ]
        Resource = [
          aws_dynamodb_table.event_log.arn,
          "${aws_dynamodb_table.event_log.arn}/stream/*",
        ]
      },
      {
        Sid      = "SQSSendStagedEvents"
        Effect   = "Allow"
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.staged_events.arn
      },
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-staging-forwarder-${terraform.workspace}:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# OneDrive adapter role (6.5.1.1): vault + delta state + profiles + event log,
# S3 put for landing, delta-trigger queue read, onedrive SSM secrets
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_adapter_onedrive_role" {
  name               = "petroglyph-adapter-onedrive-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_adapter_onedrive_policy" {
  name = "petroglyph-adapter-onedrive-policy"
  role = aws_iam_role.petroglyph_adapter_onedrive_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBAdapterReadWrite"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.token_vaults.arn,
          aws_dynamodb_table.delta_states.arn,
          aws_dynamodb_table.refresh_tokens.arn,
          aws_dynamodb_table.delta_tokens.arn,
          aws_dynamodb_table.event_log.arn,
          aws_dynamodb_table.sync_profiles.arn,
        ]
      },
      {
        Sid      = "S3PutStagedObjects"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${local.staged_bucket_arn}/*"
      },
      {
        Sid    = "SQSReadDeltaTriggerQueue"
        Effect = "Allow"
        Action = [
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ReceiveMessage",
        ]
        Resource = aws_sqs_queue.delta_trigger.arn
      },
      {
        Sid    = "SSMReadOnedriveSecrets"
        Effect = "Allow"
        Action = "ssm:GetParameter"
        Resource = "${local.ssm_arn_prefix}/petroglyph/onedrive/*"
      },
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-adapter-onedrive-${terraform.workspace}:*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Staging delivery role (6.5.2.4): index + profiles read, presign from stored
# s3Key, JWT public key via SSM
# ---------------------------------------------------------------------------

resource "aws_iam_role" "petroglyph_staging_delivery_role" {
  name               = "petroglyph-staging-delivery-${terraform.workspace}"
  assume_role_policy = local.lambda_assume_role_policy

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy" "petroglyph_staging_delivery_policy" {
  name = "petroglyph-staging-delivery-policy"
  role = aws_iam_role.petroglyph_staging_delivery_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoDBIndexAndProfilesRead"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.staged_records.arn,
          aws_dynamodb_table.sync_profiles.arn,
        ]
      },
      {
        Sid    = "S3PresignStagedObjects"
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
        Sid    = "SSMReadJwtPublicKey"
        Effect = "Allow"
        Action = "ssm:GetParameter"
        Resource = "${local.ssm_arn_prefix}/petroglyph/jwt/*"
      },
      {
        Sid    = "CloudWatchLogsWrite"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "${local.lambda_log_group_arn_prefix}/petroglyph-staging-delivery-${terraform.workspace}:*"
      },
    ]
  })
}
