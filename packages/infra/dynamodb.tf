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

# Connection-keyed token vault (6.5.1.1 adapter): the delta adapter stores and
# refreshes OneDrive OAuth tokens keyed {userId, provider}. Distinct from the
# legacy refresh_tokens table (tokenHash key) which the old processor and API
# lambdas still write — this table matches the adapter's Get/Put/UpdateCommand
# key shape so prod DDB no longer rejects its calls.

resource "aws_dynamodb_table" "token_vaults" {
  name         = "petroglyph-token-vaults-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "provider"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "provider"
    type = "S"
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

# Subscription registry (profile flows, decision 4): one Graph subscription per
# profile, keyed {profileId, provider}. Graph state — root, folder itemId,
# subscriptionId, deltaLink, clientState secret, expiry and subscriptionState —
# lives here and never on the profile row. Two access patterns drive the two
# indexes:
#
# * the webhook and lifecycle notifications arrive holding a subscriptionId and
#   nothing else, so `subscriptionId-index` answers them;
# * the hourly renewer asks which rows expire inside a 24-hour horizon, so
#   `expiry-index` ranges over the epoch seconds in `expiry`. Its partition key
#   is `provider` — the table's sort key, so every row carries it — and the
#   renewer issues one query per provider. A hash-only GSI on `expiry` could
#   not answer a window query, and one query cannot span every provider.

resource "aws_dynamodb_table" "graph_subscriptions" {
  name         = "petroglyph-graph-subscriptions-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "profileId"
  range_key    = "provider"

  attribute {
    name = "profileId"
    type = "S"
  }

  attribute {
    name = "provider"
    type = "S"
  }

  attribute {
    name = "subscriptionId"
    type = "S"
  }

  attribute {
    name = "expiry"
    type = "N"
  }

  global_secondary_index {
    name            = "subscriptionId-index"
    hash_key        = "subscriptionId"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "expiry-index"
    hash_key        = "provider"
    range_key       = "expiry"
    projection_type = "ALL"
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

# Connection-keyed delta-state store (6.5.1.1 adapter): the adapter persists
# per-connection Graph delta links keyed {userId, provider}. Distinct from the
# legacy profileId-keyed delta_tokens table which the old sync worker still
# writes — this table matches the adapter's read/write/clear key shape.

resource "aws_dynamodb_table" "delta_states" {
  name         = "petroglyph-delta-states-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "provider"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "provider"
    type = "S"
  }

  tags = {
    environment = terraform.workspace
  }
}

# ---------------------------------------------------------------------------
# Event log (the registry's DDB transport, Q8) and the staging index
# ---------------------------------------------------------------------------
#
# The event log holds one CloudEvent document per row, keyed source+id with a
# put-if-absent condition at write. The stream pushes INSERT rows to the
# staging forwarder (6.5.2.2). Rows are immutable — NEW_IMAGE is all a
# consumer ever needs.

resource "aws_dynamodb_table" "event_log" {
  name         = "petroglyph-event-log-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "source"
  range_key    = "id"

  attribute {
    name = "source"
    type = "S"
  }

  attribute {
    name = "id"
    type = "S"
  }

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  tags = {
    environment = terraform.workspace
  }
}

# The new neutral index over staged records (record key {profileId, itemId} —
# distinct from the legacy file_records table which the old processor still
# writes). Records carry expiresAt so TTL retirement aligns with the S3
# expire-staged-pdfs lifecycle.

resource "aws_dynamodb_table" "staged_records" {
  name         = "petroglyph-staged-records-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "profileId"
  range_key    = "itemId"

  attribute {
    name = "profileId"
    type = "S"
  }

  attribute {
    name = "itemId"
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

resource "aws_dynamodb_table" "sync_jobs" {
  name         = "petroglyph-sync-jobs-${terraform.workspace}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"

  attribute {
    name = "jobId"
    type = "S"
  }

  stream_enabled = true
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
