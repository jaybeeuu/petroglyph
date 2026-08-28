resource "aws_dynamodb_table" "users" {
  name         = "petroglyph-users-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_dynamodb_table" "refresh_tokens" {
  name         = "petroglyph-refresh-tokens-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tokenHash"

  attribute {
    name = "tokenHash"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_dynamodb_table" "sync_profiles" {
  name         = "petroglyph-sync-profiles-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "profileId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "profileId"
    type = "S"
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_dynamodb_table" "file_records" {
  name         = "petroglyph-file-records-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "profileId"
  range_key    = "fileId"

  attribute {
    name = "profileId"
    type = "S"
  }

  attribute {
    name = "fileId"
    type = "S"
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_dynamodb_table" "delta_tokens" {
  name         = "petroglyph-delta-tokens-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "profileId"

  attribute {
    name = "profileId"
    type = "S"
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_dynamodb_table" "sync_jobs" {
  name         = "petroglyph-sync-jobs-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"

  attribute {
    name = "jobId"
    type = "S"
  }

  stream_enabled   = true
  # NEW_AND_OLD_IMAGES keeps NewImage on INSERT (the relay fan-out path) and
  # adds OldImage on REMOVE — the only place the relay's TTL-retry backstop can
  # read the pre-deletion job (a NEW_IMAGE-only stream emits no item image on
  # REMOVE). Changing StreamViewType is an in-place stream-spec update.
  stream_view_type = "NEW_AND_OLD_IMAGES"

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  tags = {
    environment = terraform.workspace
  }
}
