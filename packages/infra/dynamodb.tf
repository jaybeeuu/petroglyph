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
