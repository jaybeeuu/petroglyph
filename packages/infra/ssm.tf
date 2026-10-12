# Read the live onedrive client id so Lambda env vars can be baked at plan time even
# when terraform runs with -refresh=false. The underlying parameter is updated
# manually (ignore_changes on the resource), so referencing the resource's stale
# state value would bake PLACEHOLDER into env vars.
data "aws_ssm_parameter" "onedrive_client_id" {
  name = aws_ssm_parameter.onedrive_client_id.name
}

resource "aws_ssm_parameter" "github_client_id" {
  name  = "${local.ssm_parameter_prefix}/github/client-id"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "github_client_secret" {
  name  = "${local.ssm_parameter_prefix}/github/client-secret"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "jwt_signing_secret" {
  name  = "${local.ssm_parameter_prefix}/jwt/signing-secret"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "jwt_private_key" {
  name  = "${local.ssm_parameter_prefix}/jwt/private-key"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "jwt_public_key" {
  name  = "${local.ssm_parameter_prefix}/jwt/public-key"
  type  = "SecureString"
  value = "PLACEHOLDER"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_client_id" {
  name  = "${local.ssm_parameter_prefix}/onedrive/client-id"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_client_secret" {
  name  = "${local.ssm_parameter_prefix}/onedrive/client-secret"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_access_token" {
  name  = "${local.ssm_parameter_prefix}/onedrive/access-token"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_refresh_token" {
  name  = "${local.ssm_parameter_prefix}/onedrive/refresh-token"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "onedrive_token_expiry" {
  name  = "${local.ssm_parameter_prefix}/onedrive/token-expiry"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "graph_subscription_id" {
  name  = "${local.ssm_parameter_prefix}/graph/subscription-id"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "config_target_branch" {
  name  = "${local.ssm_parameter_prefix}/config/target-branch"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "config_initial_sync" {
  name  = "${local.ssm_parameter_prefix}/config/initial-sync"
  type  = "SecureString"
  value = "PLACEHOLDER"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_ssm_parameter" "config_retention_days" {
  name  = "${local.ssm_parameter_prefix}/config/retention-days"
  type  = "SecureString"
  value = "90"


  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    environment = terraform.workspace
  }
}
